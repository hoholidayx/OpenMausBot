import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { Outcome, ReceiptResult, ReceiptState } from "../runtime/types.ts";
import { DotsClient, DotsHttpError, type DotsReceipt } from "./client.ts";
import { uploadBytes } from "./files.ts";
import { DotsInbox, type DotsJob, type DotsTurn } from "./inbox.ts";

export interface DotsProjection {
  available(): boolean;
  restoreQueued(): void;
  permitted(turn: DotsTurn): boolean;
  project(receipt: DotsReceipt, job: DotsJob | null): boolean;
  complete(id: string, result: ReceiptResult): boolean;
}

export function dotsText(receipt: DotsReceipt) {
  return receipt.text || (["reply", "progress", "push"].includes(receipt.kind) ? "" : [receipt.kind, receipt.problem || receipt.reason].filter(Boolean).join(" · "));
}

function receiptResult(receipt: DotsReceipt, delivered: boolean): ReceiptResult {
  if (!delivered) return { kind: "failed", outcome: "refused", text: "Dots source or work conversation is unavailable." };
  const text = dotsText(receipt);
  if (receipt.kind === "reply") return { kind: "completed", text };
  if (receipt.kind === "cancel") return { kind: "failed", outcome: "interrupted", remoteCancelled: true, text };
  return { kind: "failed", outcome: receipt.kind === "expired" ? "expired" : "provider_error", text };
}

export class DotsHost {
  readonly inbox: DotsInbox;
  readonly client: DotsClient;
  private readonly shutdown = new AbortController();
  private sending?: { id: string; controller: AbortController };
  private workers?: Promise<void[]>;
  constructor(inbox: DotsInbox, client: DotsClient) { this.inbox = inbox; this.client = client; }

  start(projection: DotsProjection) {
    if (this.workers) return;
    this.workers = Promise.all([
      this.repeat(() => this.sendNext(projection)),
      this.repeat(() => this.receive(projection)),
      this.repeat(async () => {
        const rows = this.inbox.pending();
        if (rows.length && !projection.available()) return 1000;
        let deferred = false;
        for (const { receipt, op } of rows) {
          const job = op ? this.inbox.get(op) : null;
          const delivered = projection.project(receipt, job);
          if (job?.result?.id === receipt.id) {
            const assignment = job.turn.parent ? job.turn.id : job.turn.rootId;
            if ((job.turn.parent || assignment !== job.turn.id) && !projection.complete(assignment, receiptResult(receipt, delivered))) {
              deferred = true;
              continue;
            }
          }
          this.inbox.applied(receipt.id, delivered);
        }
        return rows.length === 100 && !deferred ? 0 : 150;
      }),
    ]);
  }

  private async repeat(step: () => Promise<number>) {
    const { signal } = this.shutdown;
    while (!signal.aborted) {
      let wait = 2000;
      try { wait = await step(); }
      catch (error) {
        if (error instanceof DotsHttpError && error.status === 401) wait = 10_000;
      }
      if (wait && !signal.aborted) await delay(wait, undefined, { signal }).catch(() => {});
    }
  }

  private async sendNext(projection: DotsProjection) {
    projection.restoreQueued();
    const job = this.inbox.nextSend();
    if (!job) return 250;
    if (!projection.available()) return 1000;
    const { turn, uploaded } = job;
    const controller = new AbortController();
    this.sending = { id: turn.id, controller };
    const signal = AbortSignal.any([this.shutdown.signal, controller.signal]);
    const checkSource = () => {
      if (signal.aborted || this.inbox.get(turn.id)?.stopped || !projection.permitted(turn)) throw new DotsHttpError(403, "Source access changed.");
    };
    try {
      checkSource();
      for (const file of turn.files.slice(uploaded.length)) {
        const bytes = await uploadBytes(file).catch(() => { throw new DotsHttpError(422, "The original attachment is unavailable or exceeds 20 MiB."); });
        checkSource();
        uploaded.push(await this.client.upload(file.name, file.mime, bytes, signal));
        this.inbox.recordUploads(turn.id, uploaded);
      }
      checkSource();
      this.inbox.accepted(turn.id, await this.client.submit(turn.id, turn.text, uploaded, signal));
    } catch (error) {
      if (signal.aborted || this.inbox.get(turn.id)?.stopped) return 0;
      if (!projection.available()) return 1000;
      if (error instanceof DotsHttpError && error.status < 500 && ![401, 408, 429].includes(error.status)) {
        this.inbox.capture({ id: "host-" + turn.id, kind: "failed", sequence: 0, problem: error.message }, turn.id);
      } else {
        this.inbox.retryLater(turn.id);
      }
    } finally { this.sending = undefined; }
    return 0;
  }

  stopWaiting(id: string) {
    if (!this.inbox.stopWaiting(id)) return false;
    if (this.sending?.id === id) this.sending.controller.abort();
    return true;
  }

  private async operation(event: DotsReceipt) {
    if (event.kind === "push") return;
    if (!event.message_id) return event.correlation_id && this.inbox.get(event.correlation_id) ? event.correlation_id : undefined;
    const local = this.inbox.operation(event.message_id);
    let key = event.correlation_id;
    if (!local && !key) {
      try { key = (await this.client.message(event.message_id, this.shutdown.signal)).correlation_id; }
      catch (error) { if (!(error instanceof DotsHttpError && error.status === 404)) throw error; }
    }
    if (!key) return local;
    const job = this.inbox.get(key);
    if (job && (!job.local || job.local === event.message_id) && (!local || local === key)) return key;
  }

  private async receive(projection: DotsProjection) {
    if (!projection.available()) return 1000;
    const { signal } = this.shutdown;
    const events = await this.client.events(signal);
    if (!events.length) return 100;
    if (!projection.available()) return 1000;
    for (const event of events) {
      const op = await this.operation(event);
      if (!projection.available()) return 1000;
      this.inbox.capture(event, op);
    }
    await this.client.acknowledge(events[events.length - 1]!.sequence, signal);
    return 0;
  }

  receiptMatches(id: string, outcome: Outcome) {
    const receipt = this.inbox.get(id)?.result;
    if (!receipt) return false;
    const result = receiptResult(receipt, true);
    return outcome === (result.kind === "completed" ? "done" : result.outcome);
  }

  receiptState(job: DotsJob): ReceiptState {
    if (job.result) {
      const state = this.inbox.projectionOf(job.result.id);
      if (state === 1 || state === -1) return receiptResult(job.result, state === 1);
    }
    if (job.stopped) return { kind: "failed", outcome: "stopped", text: "Stopped waiting for Dots." };
    return { kind: "awaiting_receipt" };
  }

  async stop() { this.shutdown.abort(); await this.workers; }
}

export function openDotsHost(dataDir: string): DotsHost | undefined {
  const dir = join(dataDir, "providers", "dots"), config = join(dir, "connection.json");
  if (!existsSync(config)) return;
  try {
    const settings = z.object({
      port: z.number().int().min(1).max(65535).default(18767),
      tokenFile: z.string().refine(isAbsolute).optional(),
    }).strict().parse(JSON.parse(readFileSync(config, "utf8")));
    return new DotsHost(new DotsInbox(join(dir, "inbox.sqlite")), new DotsClient(settings.port, settings.tokenFile ?? join(dir, "host.token")));
  } catch {
    console.warn("Dots inbox unavailable. Check providers/dots/connection.json and its data directory.");
    return;
  }
}
