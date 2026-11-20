import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  launchVerificationServer,
  verificationServerArgs,
  verificationServerEnvironment,
} from "../scripts/control-omb.ts";
import {
  applyPendingWorkspaceRestore,
  commitPendingWorkspaceRestore,
  createWorkspaceBackup,
  stageWorkspaceBackup,
} from "./workspace-backup.ts";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { AsyncImageJobs } from "./async-image-jobs.ts";
import { ATTACHMENTS_DIR, saveImage } from "./attachments.ts";
import { DATA_DIR } from "./config.ts";
import { IMAGE_DAY_FILE, localDay } from "./image-daily-cap.ts";
import {
  claimImageQuota,
  findImageJob,
  imageDownloadVisible,
  pendingImageFiles,
  releaseImageQuota,
  syncImageReservation,
  type ImageJob,
} from "./image-job-store.ts";
import { closeMessageDb, prepared, readMessage } from "./message-db.ts";
import { Store } from "./store.ts";
import { fixtureImageBridge, fixturePng } from "./testing/image-bridge.ts";

let remote: Awaited<ReturnType<typeof fixtureImageBridge>>;
let environment: string;
let worker: AsyncImageJobs;
let store: Store;
let enabled = true;
let binding = "fixture";
const selection = () => ({ instanceId: "claude", model: "fixture" });
const host = () =>
  new AsyncImageJobs({
    store,
    environment,
    dataDir: DATA_DIR,
    maxPerTurn: () => 4,
    target: () =>
      enabled ? { name: "bridge", fingerprint: binding, spec: { type: "http", url: remote.url, headers: {} } } : null,
  });
const wait = <T>(fn: () => T) => expect.poll(fn, { timeout: 9_000, interval: 25 });
const usage = (day = localDay(new Date())) =>
  prepared("SELECT used FROM image_days WHERE environment=? AND day=?").get(environment, day)?.used;
const source = () => {
  const bot = store.createBot({ name: "Image fixture" });
  const thread = bot.threadId;
  const user = store.appendMessage(thread, { role: "user", kind: "text", text: "Draw the station." }).id;
  return { bot: bot.id, thread, user };
};
function add(line: ReturnType<typeof source>, slot = 1, prompt = "Train at dusk") {
  const receipt = worker.enqueue(line.bot, line.thread, line.user, "turn", { prompt, image_index: slot });
  const job = findImageJob(environment, line.bot, line.thread, line.user, slot)!;
  expect(job.card).toBe(receipt.cardId);
  return job;
}
const phase = (job: ImageJob) => prepared("SELECT phase FROM image_jobs WHERE id=?").get(job.id)?.phase;
const expedite = (job: ImageJob) => prepared("UPDATE image_jobs SET nextAt=0 WHERE id=?").run(job.id);
async function restart() {
  worker.stop();
  await wait(() => worker.busy).toBe(false);
  closeMessageDb();
  store = new Store(selection);
  worker = host();
  worker.start();
}
beforeEach(async () => {
  remote = await fixtureImageBridge();
  environment = randomUUID();
  enabled = true;
  binding = "fixture";
  store = new Store(selection);
  worker = host();
});
afterEach(async () => {
  worker.stop();
  await wait(() => worker.busy).toBe(false);
  await remote.close();
  closeMessageDb();
});

it("recovers local acceptance, a lost receipt and a committed PNG under the original IDs", async () => {
  const line = source(),
    fresh = add(line),
    lost = add(line, 2),
    written = add(line, 3);
  expect(add(line).card).toBe(fresh.card);
  expect(() => add(line, 1, "Changed")).toThrow(/different/);
  expect(() => add(line, 5)).toThrow(/limit/);
  const seeded = [lost, written];
  for (const j of seeded) remote.tasks.set(j.id, "completed");
  prepared("UPDATE image_jobs SET phase='submitting',nextAt=?,claim='crashed' WHERE id=?").run(
    Date.now() + 65_000,
    lost.id,
  );
  prepared("UPDATE image_jobs SET phase='fetching',digest=?,nextAt=?,claim='crashed' WHERE id=?").run(
    remote.sha256,
    Date.now() + 65_000,
    written.id,
  );
  const saved = saveImage(fixturePng, "image/png", written.attachment);
  expect(imageDownloadVisible(written.attachment + ".png", () => true)).toBe(false);
  remote.control.complete = true;
  await restart();
  await wait(() => [fresh, lost, written].map(phase)).toEqual(["done", "done", "done"]);
  expect(remote.calls.filter((c) => c.name === "image_submit").map((c) => c.id)).toEqual([fresh.id]);
  expect(remote.calls.some((c) => c.id === written.id)).toBe(false);
  expect(remote.tasks.size).toBe(3);
  expect(prepared("SELECT seedUsed FROM image_jobs WHERE id=?").get(fresh.id)?.seedUsed).toBe("18446744073709551615");
  for (const job of [fresh, lost, written]) {
    const file = join(ATTACHMENTS_DIR, job.attachment + ".png");
    expect(job.attachment).not.toBe(job.id);
    expect(readMessage(job.thread, job.card)).toMatchObject({ replyToId: line.user, attachments: [{ path: file }] });
    expect(readFileSync(file)).toEqual(fixturePng);
  }
  expect(readMessage(line.thread, written.card)?.attachments?.[0]?.path).toBe(saved.path);
  expect(usage()).toBe(3);
  const calls = remote.calls.length;
  await restart();
  expect(remote.calls).toHaveLength(calls);
  expect(usage()).toBe(3);
});

it("replays the original UUID after an unknown submission and only queries a previously acknowledged job", async () => {
  const line = source(),
    lost = add(line),
    known = add(line, 2);
  prepared("UPDATE image_jobs SET phase='submitting' WHERE id=?").run(lost.id);
  prepared("UPDATE image_jobs SET phase='polling', troubleSince=? WHERE id=?").run(Date.now() - 1_300_000, known.id);
  remote.control.complete = true;
  await restart();
  await wait(() => [phase(lost), phase(known)]).toEqual(["done", "review"]);
  expect(remote.calls.filter((c) => c.id === lost.id).map((c) => c.name)).toEqual([
    "image_status",
    "image_submit",
    "image_result",
  ]);
  expect(remote.calls.filter((c) => c.id === known.id).map((c) => c.name)).toEqual(["image_status"]);
  remote.tasks.set(known.id, "completed");
  expect(worker.recheck(known.thread, known.card)).toBe(true);
  await wait(() => phase(known)).toBe("done");
  expect(usage()).toBe(2);
});

it("keeps a verified local PNG during a delivery pause and completes a manual recheck directly from disk", async () => {
  const line = source();
  const job = add(line);
  const filename = job.attachment + ".png";
  saveImage(fixturePng, "image/png", job.attachment);
  prepared("UPDATE image_jobs SET phase='review', digest=?, nextAt=NULL WHERE id=?").run(remote.sha256, job.id);
  expect(pendingImageFiles()).toContain(filename);
  expect(imageDownloadVisible(filename, () => true)).toBe(false);
  expect(imageDownloadVisible(filename.toUpperCase(), () => true)).toBe(false);
  remote.tasks.set(job.id, "expired");
  worker.start();
  expect(worker.recheck(job.thread, job.card)).toBe(true);
  await wait(() => phase(job)).toBe("done");
  expect(remote.calls).toEqual([]);
  expect(usage()).toBe(1);
  expect(pendingImageFiles()).not.toContain(filename);
  expect(imageDownloadVisible(filename, (thread) => thread === job.thread)).toBe(true);
  expect(imageDownloadVisible(filename, () => false)).toBe(false);
  expect(imageDownloadVisible(job.attachment.toUpperCase() + ".png", () => false)).toBe(false);
});

it("releases a provider refusal and retains quota for a lost output or an unknown remote failure", async () => {
  const line = source();
  const codes = ["provider_request_rejected", "output_source_denied", "unrecognized_failure"];
  const jobs = codes.map((code, index) => {
    const job = add(line, index + 1);
    remote.tasks.set(job.id, "failed");
    remote.failures.set(job.id, code);
    return job;
  });
  worker.start();
  await wait(() => jobs.map(phase)).toEqual(["failed", "failed", "failed"]);
  expect(jobs.map((job) => readMessage(job.thread, job.card)?.imageJob?.reason)).toEqual([
    "provider_request_rejected",
    "output_source_denied",
    "generation_failed",
  ]);
  expect(usage()).toBe(2);
});

it("shares reservations across bots and the synchronous provider, rolls back rejected cards and settles on their original day", async () => {
  const a = source(),
    b = source(),
    today = localDay(new Date());
  const file = join(DATA_DIR, IMAGE_DAY_FILE),
    previous = existsSync(file) ? readFileSync(file) : null;
  writeFileSync(file, JSON.stringify({ day: today, count: 47 }));
  try {
    const finish = syncImageReservation(environment, DATA_DIR)!;
    const first = add(a),
      second = add(b);
    expect(usage()).toBe(50);
    expect(syncImageReservation(environment, DATA_DIR)).toBeNull();
    expect(() => add(b, 2)).toThrow(/daily limit/);
    expect(store.messagesFor(b.thread).filter((m) => m.imageJob)).toHaveLength(1);
    finish(false);
    expect(usage()).toBe(49);
    const next = "2099-01-02";
    expect(claimImageQuota(environment, DATA_DIR, next)).toBe(true);
    releaseImageQuota(environment, today);
    expect(usage(next)).toBe(1);
    enabled = false;
    worker.start();
    await wait(() => [phase(first), phase(second)]).toEqual(["failed", "failed"]);
    expect(usage()).toBe(46);
  } finally {
    writeFileSync(file, previous ?? "{}");
  }
});

it("freezes imported pending work while keeping an imported completed attachment accessible through its history", async () => {
  const line = source(),
    finished = add(line),
    pending = add(line, 2);
  prepared("UPDATE image_jobs SET nextAt=NULL WHERE id=?").run(pending.id);
  remote.control.complete = true;
  worker.start();
  await wait(() => phase(finished)).toBe("done");
  worker.stop();
  await wait(() => worker.busy).toBe(false);
  expedite(pending);
  const calls = remote.calls.length;
  environment = randomUUID();
  await restart();
  await wait(() => phase(pending)).toBe("failed");
  expect(remote.calls).toHaveLength(calls);
  expect(readMessage(line.thread, pending.card)?.imageJob?.reason).toBe("other_installation");
  expect(imageDownloadVisible(finished.attachment + ".png", (id) => id === line.thread)).toBe(true);
  expect(imageDownloadVisible(finished.attachment + ".png", () => false)).toBe(false);
});

it("patches the original branch and omits live cards from a fork", async () => {
  const line = source(),
    job = add(line);
  const follow = store.appendMessage(line.thread, { role: "user", kind: "text", text: "What time is it?" });
  const fork = store.forkTask(line.bot, line.thread, follow.id)!;
  expect(store.messagesFor(fork.threadId).some((row) => row.id === job.card)).toBe(false);
  expect(readMessage(fork.threadId, follow.id)?.parentId).toBe(line.user);
  expect(store.forkTask(line.bot, line.thread, job.card)).toBeNull();
  store.branchMessage(line.thread, line.user, "Another branch");
  const leaf = store.activeLeaf(line.thread);
  remote.control.complete = true;
  worker.start();
  await wait(() => phase(job)).toBe("done");
  expect(store.activeLeaf(line.thread)).toBe(leaf);
  expect(store.activePath(line.thread).some((m) => m.id === job.card)).toBe(false);
  store.setActiveLeaf(line.thread, job.card);
  const doneFork = store.forkTask(line.bot, line.thread, job.card)!;
  expect(readMessage(doneFork.threadId, job.card)?.attachments).toEqual(
    readMessage(line.thread, job.card)?.attachments,
  );
  expect(imageDownloadVisible(job.attachment + ".png", (id) => id === doneFork.threadId)).toBe(true);
});

it("retains spent quota for invalid and expired results and stops publication when the target changes", async () => {
  const line = source(),
    expired = add(line),
    invalid = add(line, 2),
    removed = add(line, 3),
    deletedSource = add(source());
  remote.tasks.set(expired.id, "expired");
  remote.tasks.set(invalid.id, "completed");
  remote.control.badDigest = true;
  prepared("UPDATE image_jobs SET phase='polling' WHERE id IN (?,?)").run(expired.id, invalid.id);
  prepared("DELETE FROM messages WHERE thread_id=? AND id=?").run(line.thread, removed.card);
  prepared("DELETE FROM messages WHERE thread_id=? AND id=?").run(deletedSource.thread, deletedSource.source);
  worker.start();
  await wait(() => [expired, invalid, removed, deletedSource].map(phase)).toEqual([
    "failed",
    "failed",
    "failed",
    "failed",
  ]);
  expect(readMessage(line.thread, expired.card)?.imageJob?.reason).toBe("result_expired");
  expect(readMessage(line.thread, invalid.card)?.imageJob?.reason).toBe("output_invalid");
  expect(usage()).toBe(2);
  expect(remote.calls.some((call) => call.id === removed.id || call.id === deletedSource.id)).toBe(false);
  expect(existsSync(join(ATTACHMENTS_DIR, invalid.attachment + ".png"))).toBe(false);
});

it("delivers each picture to its own card when the second one finishes first", async () => {
  const line = source();
  const first = add(line, 1, "A candle");
  const second = add(line, 2, "A lantern");
  worker.start();
  await wait(() => [first, second].map(phase)).toEqual(["polling", "polling"]);
  remote.tasks.set(second.id, "completed");
  await restart();
  await wait(() => [first, second].map(phase)).toEqual(["polling", "done"]);
  expect(readMessage(line.thread, first.card)?.attachments).toBeUndefined();
  remote.tasks.set(first.id, "completed");
  await restart();
  await wait(() => phase(first)).toBe("done");
  for (const job of [first, second])
    expect(readMessage(line.thread, job.card)).toMatchObject({
      replyToId: line.user,
      attachments: [{ path: join(ATTACHMENTS_DIR, job.attachment + ".png") }],
    });
  expect(remote.calls.filter((c) => c.name === "image_submit")).toHaveLength(2);
  expect(usage()).toBe(2);
});

it("retries a full queue under one UUID, follows uncertainty to completion, and stops after disconnection", async () => {
  const line = source(),
    job = add(line);
  remote.control.refusal = "queue_full";
  worker.start();
  await wait(() => readMessage(line.thread, job.card)?.imageJob?.reason).toBe("queue_full");
  remote.control.refusal = "";
  remote.tasks.set(job.id, "submission_uncertain");
  await restart();
  await wait(() => readMessage(line.thread, job.card)?.imageJob?.reason).toBe("submission_uncertain");
  remote.control.complete = true;
  await restart();
  await wait(() => phase(job)).toBe("done");
  expect(remote.tasks.size).toBe(1);
  const second = add(line, 2);
  enabled = false;
  await wait(() => phase(second)).toBe("failed");
  expect(usage()).toBe(1);
  expect(remote.calls.some((c) => c.id === second.id)).toBe(false);
});

it("withholds an accepted result after the connection is replaced", async () => {
  const job = add(source());
  worker.start();
  await wait(() => phase(job)).toBe("polling");
  binding = "another connection";
  remote.control.complete = true;
  await restart();
  await wait(() => phase(job)).toBe("failed");
  expect(remote.calls.map((call) => call.name)).toEqual(["image_submit"]);
  expect(readMessage(job.thread, job.card)?.attachments).toBeUndefined();
  expect(usage()).toBe(1);
});

it("restores the encrypted archive into another installation and serves only its finished image", async () => {
  const line = source(),
    finished = add(line),
    pending = add(line, 2);
  prepared("UPDATE image_jobs SET nextAt=NULL WHERE id=?").run(pending.id);
  remote.control.complete = true;
  worker.start();
  await wait(() => phase(finished)).toBe("done");
  worker.stop();
  await wait(() => worker.busy).toBe(false);
  expedite(pending);
  closeMessageDb();
  const password = randomUUID();
  const archive = await createWorkspaceBackup(DATA_DIR, { password });
  const other = await launchVerificationServer();
  const { dataDir, url } = other.info;
  const stopped = once(other.child, "exit");
  other.child.kill("SIGTERM");
  await stopped;
  try {
    const staged = await stageWorkspaceBackup(dataDir, archive.path, { password });
    commitPendingWorkspaceRestore(dataDir, staged.id);
    expect(applyPendingWorkspaceRestore(dataDir).restored).toBe(true);
    const count = remote.calls.length;
    const env = verificationServerEnvironment({}, dataDir, Number(new URL(url).port));
    const replacement = spawn(process.execPath, verificationServerArgs(env), { env, stdio: "ignore" });
    try {
      const rows = async () => {
        const res = await fetch(url + "/api/threads/" + line.thread + "/messages").catch(() => null);
        return res?.ok
          ? ((await res.json()) as { messages: Array<{ id: string; imageJob?: { state: string; reason?: string } }> })
              .messages
          : [];
      };
      await expect
        .poll(async () => (await rows()).find((row) => row.id === pending.card)?.imageJob, { timeout: 20_000 })
        .toMatchObject({ state: "failed", reason: "other_installation" });
      const response = await fetch(url + "/api/attachments/" + finished.attachment + ".png");
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(fixturePng);
      expect(remote.calls).toHaveLength(count);
    } finally {
      if (replacement.exitCode === null && replacement.signalCode === null) {
        const ended = once(replacement, "exit");
        replacement.kill("SIGTERM");
        await ended;
      }
    }
  } finally {
    await other.close();
  }
}, 40_000);
