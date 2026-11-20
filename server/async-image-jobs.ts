import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ATTACHMENTS_DIR, readAttachment, saveImage } from "./attachments.ts";
import type { RemoteMcpSpec } from "./contracts.ts";
import { startDueTimer, type DueTimer } from "./due-timer.ts";
import { ImageBridge, ImageBridgeError, imageDigest, imageRequest, safeImageError } from "./image-bridge.ts";
import { localDay } from "./image-daily-cap.ts";
import {
  claimImageJobs, claimImageQuota, findImageJob, imageSlotsUsed, nextImageDue, recheckImageJob,
  releaseImageQuota, saveImageJob, updateImageJob, type ImageJob, type ImageJobUpdate,
} from "./image-job-store.ts";
import { prepared, readMessage, transaction } from "./message-db.ts";
import type { Message, Store } from "./store.ts";

export interface ImageTarget { name: string; fingerprint: string; spec: RemoteMcpSpec }
type ImageCard = NonNullable<Message["imageJob"]>;
const statusLine: Record<ImageCard["state"], string> = {
  queued: "Image queued.", running: "Generating image.", done: "Image ready.", failed: "Image unavailable.", review: "Image awaiting confirmation.",
};
const refuse = (status: number, message: string) => Object.assign(new Error(message), { status });
const pollDelay = 2_000;
const retryBudget = 20 * 60_000;

interface ImageJobHost {
  store: Pick<Store, "botByThread" | "activePath" | "appendMessage" | "patchMessage">;
  environment: string; dataDir: string; target(bot: string): ImageTarget | null;
  connection?(target: ImageTarget): Promise<RemoteMcpSpec>;
  maxPerTurn(): number;
}

export class AsyncImageJobs {
  private timer?: DueTimer;
  private controller?: AbortController;
  busy = false;
  private readonly deps: ImageJobHost;
  constructor(deps: ImageJobHost) { this.deps = deps; }

  start() {
    if (this.timer) return;
    const { environment } = this.deps;
    prepared("UPDATE image_jobs SET nextAt=0, claim='' WHERE environment=? AND nextAt IS NOT NULL AND claim!=''").run(environment);
    const imported = prepared("SELECT * FROM image_jobs WHERE environment!=? AND phase NOT IN ('done','failed')").all(environment) as unknown as ImageJob[];
    for (const job of imported) this.finish(job, "failed", "other_installation");
    const controller = this.controller = new AbortController();
    this.timer = startDueTimer({
      next: () => nextImageDue(environment), retryMs: 50,
      run: async () => {
        this.busy = true;
        try { await Promise.allSettled(claimImageJobs(environment, Date.now()).map(job => this.run(job, controller.signal))); }
        finally { this.busy = false; }
      },
    });
  }
  stop() {
    this.timer?.stop();
    this.timer = undefined;
    this.controller?.abort();
  }

  enqueue(bot: string, thread: string, source: string, turn: string, input: unknown, parked = 0) {
    const { store, environment, dataDir } = this.deps;
    const target = this.deps.target(bot);
    if (!target || store.botByThread(thread)?.id !== bot ||
        !store.activePath(thread).some(row => row.id === source && row.role === "user" && row.kind === "text")) {
      throw refuse(403, "Ask for an image in an authorized private chat.");
    }
    const parsed = imageRequest.safeParse(input);
    if (!parsed.success) throw refuse(400, "Check the image prompt, size and image_index.");
    const { prompt, size, image_index: slot } = parsed.data;
    const paramsHash = imageDigest(JSON.stringify([prompt, size]));
    const existing = findImageJob(environment, bot, thread, source, slot);
    if (existing) {
      if (existing.paramsHash !== paramsHash) throw refuse(409, "This image_index already has a different request.");
      return { cardId: existing.card, text: "Already accepted. The original image card tracks this request." };
    }
    const limit = this.deps.maxPerTurn();
    if (slot > limit || imageSlotsUsed(environment, thread, source) + parked >= limit) throw refuse(429, "This request reached its image limit.");
    const day = localDay(new Date());
    const card = store.appendMessage(thread, { role: "bot", kind: "text", text: statusLine.queued, replyToId: source, imageJob: { state: "queued" } }, undefined, message => {
      if (!claimImageQuota(environment, dataDir, day)) throw refuse(429, "This installation reached its daily limit of 50 images.");
      saveImageJob({ id: randomUUID(), attachment: randomUUID(), environment, bot, thread, source, turn, slot, card: message.id,
        server: target.name, fingerprint: target.fingerprint, paramsHash, prompt, size, phase: "queued", day, nextAt: Date.now(),
        claim: "", errors: 0, troubleSince: 0, digest: "" });
    });
    this.timer?.poke();
    return { cardId: card.id, text: "Image queued in this chat. Finish this reply. Its original card will receive the picture automatically." };
  }

  recheck(thread: string, card: string) {
    const changed = recheckImageJob(this.deps.environment, thread, card);
    if (changed) this.timer?.poke();
    return changed;
  }

  private target(job: ImageJob) {
    if (this.deps.store.botByThread(job.thread)?.id !== job.bot || readMessage(job.thread, job.source)?.role !== "user" ||
        readMessage(job.thread, job.card)?.replyToId !== job.source) return null;
    const target = this.deps.target(job.bot);
    return target?.name === job.server && target.fingerprint === job.fingerprint ? target : null;
  }
  private change(job: ImageJob, update: ImageJobUpdate, card: ImageCard, release = false, path?: string) {
    const commit = () => {
      updateImageJob(job, update);
      if (release) releaseImageQuota(job.environment, job.day);
    };
    const prior = readMessage(job.thread, job.card);
    if (!prior || (prior.imageJob?.state === card.state && prior.imageJob.reason === card.reason && prior.imageJob.recheck === card.recheck && !path)) {
      transaction(commit);
      return;
    }
    if (!this.deps.store.patchMessage(job.thread, job.card, { imageJob: card, text: statusLine[card.state],
      ...(path ? { attachments: [{ kind: "image", mime: "image/png", path }] } : {}) }, undefined, commit)) transaction(commit);
  }
  private finish(job: ImageJob, phase: "done" | "failed" | "review", reason?: string, release = false, path?: string) {
    this.change(job, { phase, nextAt: null, prompt: "" }, { state: phase, ...(phase === "review" ? { recheck: true as const } : {}), ...(reason ? { reason } : {}) }, release, path);
  }
  private retry(job: ImageJob, reason: string, knownRejected = false) {
    const since = job.troubleSince || Date.now();
    if (Date.now() - since >= retryBudget) {
      this.finish(job, knownRejected ? "failed" : "review", reason, knownRejected);
      return;
    }
    const delay = Math.min(60_000, 5_000 * 2 ** Math.min(4, job.errors));
    this.change(job, { phase: job.phase, errors: job.errors + 1, troubleSince: since, nextAt: Date.now() + delay },
      { state: knownRejected ? "queued" : "review", reason });
  }

  private async run(job: ImageJob, signal: AbortSignal) {
    const target = this.target(job);
    if (!target) return this.finish(job, "failed", "access_changed", job.phase === "queued");
    let bridge: ImageBridge | undefined;
    const authorized = () => {
      if (signal.aborted) throw signal.reason;
      if (!this.target(job)) throw new ImageBridgeError("access_changed");
    };
    try {
      if (job.phase === "fetching" && job.digest) {
        const file = readAttachment(job.attachment + ".png");
        if (file && imageDigest(file.bytes) === job.digest) return this.finish(job, "done", undefined, false, join(ATTACHMENTS_DIR, job.attachment + ".png"));
      }
      const spec = this.deps.connection ? await this.deps.connection(target) : target.spec;
      authorized();
      bridge = new ImageBridge(spec, signal);
      await bridge.open();
      authorized();
      if (job.phase === "fetching") {
        const result = await bridge.result(job.id);
        authorized();
        if (job.digest && job.digest !== result.digest) throw new ImageBridgeError("output_invalid");
        updateImageJob(job, { phase: "fetching", nextAt: Date.now() + 65_000, digest: result.digest });
        const saved = saveImage(result.bytes, "image/png", job.attachment);
        this.finish(job, "done", undefined, false, saved.path);
        return;
      }
      const fresh = job.phase === "queued";
      if (fresh) updateImageJob(job, { phase: "submitting", nextAt: Date.now() + 65_000 });
      const args = { prompt: job.prompt, size: job.size };
      const result = await bridge.observe(job.id, fresh ? args : undefined).catch(error => {
        if (!fresh && job.phase === "submitting" && error instanceof ImageBridgeError && error.message === "task_not_found") {
          authorized();
          return bridge!.observe(job.id, args);
        }
        throw error;
      });
      authorized();
      switch (result.state) {
        case "failed": {
          const reason = safeImageError(result.error_code);
          return this.finish(job, "failed", reason, !["output_unavailable", "output_invalid"].includes(reason));
        }
        case "expired": return this.finish(job, "failed", "result_expired");
        case "submission_uncertain":
          updateImageJob(job, { phase: "polling", nextAt: Date.now() + pollDelay });
          return this.retry(job, "submission_uncertain");
        default:
          this.change(job, { phase: result.state === "completed" ? "fetching" : "polling", errors: 0, troubleSince: 0,
            nextAt: result.state === "completed" ? 0 : Date.now() + pollDelay }, { state: "running" });
      }
    } catch (error) {
      if (signal.aborted) return;
      const reason = error instanceof ImageBridgeError ? error.message : "connection_error";
      if (reason === "queue_full" && job.phase === "submitting") {
        updateImageJob(job, { phase: "queued", nextAt: 0 });
        this.retry(job, reason, true);
      } else if (reason === "result_not_ready") {
        updateImageJob(job, { phase: "polling", nextAt: Date.now() + pollDelay });
      } else if (["output_invalid", "result_expired", "access_changed", "invalid_request", "backend_unavailable", "worker_unavailable", "request_conflict"].includes(reason)) {
        this.finish(job, "failed", reason, job.phase === "queued" || (job.phase === "submitting" && ["backend_unavailable", "worker_unavailable", "invalid_request"].includes(reason)));
      } else {
        this.retry(job, reason, job.phase === "queued");
      }
    } finally {
      await bridge?.close().catch(() => {});
    }
  }
}
