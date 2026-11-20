import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { DotsClient, DotsHttpError, type DotsReceipt } from "./client.ts";
import { uploadBytes } from "./files.ts";
import { DotsInbox, type DotsJob, type DotsTurn } from "./inbox.ts";

export interface DotsProjection {
  available(): boolean;
  permitted(turn: DotsTurn): boolean;
  project(receipt: DotsReceipt, job: DotsJob | null): boolean;
}

export function dotsOutcome(receipt: DotsReceipt) {
  const providerEnd: "cancel" | "expired" | undefined = receipt.kind === "cancel" || receipt.kind === "expired" ? receipt.kind : undefined;
  return { providerEnd, ok: receipt.kind === "reply", text: receipt.text || (receipt.kind === "reply" ? "" : [receipt.kind, receipt.problem || receipt.reason].filter(Boolean).join(" · ")) };
}

export class DotsHost {
  readonly inbox: DotsInbox;
  readonly client: DotsClient;
  private readonly shutdown = new AbortController();
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
        for (const { receipt, op } of rows) {
          this.inbox.applied(receipt.id, projection.project(receipt, op ? this.inbox.get(op) : null));
        }
        return rows.length === 100 ? 0 : 150;
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
    const job = this.inbox.nextSend();
    if (!job) return 250;
    if (!projection.available()) return 1000;
    const { signal } = this.shutdown;
    const { turn, uploaded } = job;
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
      if (signal.aborted) return 0;
      if (!projection.available()) return 1000;
      if (error instanceof DotsHttpError && error.status < 500 && ![401, 408, 429].includes(error.status)) {
        this.inbox.capture({ id: "host-" + turn.id, kind: "failed", sequence: 0, problem: error.message }, turn.id);
      } else {
        this.inbox.retryLater(turn.id);
      }
    }
    return 0;
  }

  private async operation(event: DotsReceipt) {
    if (event.kind === "push" || !event.message_id) return;
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

  async run(turn: DotsTurn, signal: AbortSignal) {
    this.inbox.enqueue(turn);
    const stopped = () => {
      if (!this.shutdown.signal.aborted) this.inbox.stopWaiting(turn.id);
    };
    signal.addEventListener("abort", stopped, { once: true });
    if (signal.aborted) stopped();
    try {
      while (!signal.aborted && !this.shutdown.signal.aborted) {
        const job = this.inbox.get(turn.id)!;
        if (job.stopped) break;
        if (job.result) {
          const state = this.inbox.projectionOf(job.result.id);
          if (state === 1) return dotsOutcome(job.result);
          if (state === -1) return { ok: false, text: "Dots source or work conversation is unavailable." };
        }
        await delay(100, undefined, { signal }).catch(() => {});
      }
    } finally { signal.removeEventListener("abort", stopped); }
    return { ok: false, text: "Stopped waiting for Dots." };
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
