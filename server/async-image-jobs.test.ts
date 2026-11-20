import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { AsyncImageJobs } from "./async-image-jobs.ts";
import { ATTACHMENTS_DIR, saveImage } from "./attachments.ts";
import { DATA_DIR } from "./config.ts";
import { IMAGE_DAY_FILE, localDay } from "./image-daily-cap.ts";
import { claimImageQuota, findImageJob, imageDownloadVisible, releaseImageQuota, syncImageReservation, type ImageJob } from "./image-job-store.ts";
import { closeMessageDb, prepared, readMessage } from "./message-db.ts";
import { Store } from "./store.ts";
import { fixtureImageBridge, fixturePng } from "./testing/image-bridge.ts";

let remote: Awaited<ReturnType<typeof fixtureImageBridge>>;
let environment: string;
let worker: AsyncImageJobs;
let store: Store;
let enabled = true;
const selection = () => ({ instanceId: "claude", model: "fixture" });
const host = () => new AsyncImageJobs({
  store, environment, dataDir: DATA_DIR, maxPerTurn: () => 4,
  target: () => enabled ? { name: "bridge", fingerprint: "fixture", spec: { type: "http", url: remote.url, headers: {} } } : null,
});
const wait = <T>(fn: () => T) => expect.poll(fn, { timeout: 9_000, interval: 25 });
const usage = (day = localDay(new Date())) => prepared("SELECT used FROM image_days WHERE environment=? AND day=?").get(environment, day)?.used;
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
  environment = randomUUID(); enabled = true;
  store = new Store(selection); worker = host();
});
afterEach(async () => {
  worker.stop(); await wait(() => worker.busy).toBe(false);
  await remote.close(); closeMessageDb();
});

it("recovers local acceptance, a lost receipt and a committed PNG under the original IDs", async () => {
  const line = source(), fresh = add(line), lost = add(line, 2), written = add(line, 3);
  expect(add(line).card).toBe(fresh.card);
  expect(() => add(line, 1, "Changed")).toThrow(/different/);
  expect(() => add(line, 5)).toThrow(/limit/);
  const seeded = [lost, written];
  for (const j of seeded) remote.tasks.set(j.id, "completed");
  prepared("UPDATE image_jobs SET phase='submitting',nextAt=?,claim='crashed' WHERE id=?").run(Date.now()+65_000, lost.id);
  prepared("UPDATE image_jobs SET phase='fetching',digest=?,nextAt=?,claim='crashed' WHERE id=?").run(remote.sha256, Date.now()+65_000, written.id);
  const saved = saveImage(fixturePng, "image/png", written.attachment);
  expect(imageDownloadVisible(written.attachment + ".png", () => true)).toBe(false);
  remote.control.complete = true;
  await restart();
  await wait(() => [fresh, lost, written].map(phase)).toEqual(["done","done","done"]);
  expect(remote.calls.filter(c => c.name === "image_submit").map(c => c.id)).toEqual([fresh.id]);
  expect(remote.calls.some(c => c.id === written.id)).toBe(false);
  expect(remote.tasks.size).toBe(3);
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
  const line = source(), lost = add(line), known = add(line, 2);
  prepared("UPDATE image_jobs SET phase='submitting' WHERE id=?").run(lost.id);
  prepared("UPDATE image_jobs SET phase='polling', troubleSince=? WHERE id=?").run(Date.now()-1_300_000, known.id);
  remote.control.complete = true;
  await restart();
  await wait(() => [phase(lost), phase(known)]).toEqual(["done","review"]);
  expect(remote.calls.filter(c => c.id === lost.id).map(c => c.name)).toEqual(["image_status","image_submit","image_result"]);
  expect(remote.calls.filter(c => c.id === known.id).map(c => c.name)).toEqual(["image_status"]);
  remote.tasks.set(known.id, "completed");
  expect(worker.recheck(known.thread, known.card)).toBe(true);
  await wait(() => phase(known)).toBe("done");
  expect(usage()).toBe(2);
});

it("shares reservations across bots and the synchronous provider, rolls back rejected cards and settles on their original day", async () => {
  const a=source(), b=source(), today=localDay(new Date());
  const file=join(DATA_DIR, IMAGE_DAY_FILE), previous=existsSync(file) ? readFileSync(file) : null;
  writeFileSync(file,JSON.stringify({ day: today, count: 47 }));
  try {
    const finish=syncImageReservation(environment,DATA_DIR)!;
    const first=add(a), second=add(b);
    expect(usage()).toBe(50);
    expect(syncImageReservation(environment,DATA_DIR)).toBeNull();
    expect(() => add(b,2)).toThrow(/daily limit/);
    expect(store.messagesFor(b.thread).filter(m=>m.imageJob)).toHaveLength(1);
    finish(false); expect(usage()).toBe(49);
    const next="2099-01-02";
    expect(claimImageQuota(environment,DATA_DIR,next)).toBe(true);
    releaseImageQuota(environment,today);
    expect(usage(next)).toBe(1);
    enabled=false; worker.start();
    await wait(()=>[phase(first),phase(second)]).toEqual(["failed","failed"]);
    expect(usage()).toBe(46);
  } finally { writeFileSync(file,previous ?? "{}"); }
});

it("freezes imported pending work while keeping an imported completed attachment accessible through its history", async () => {
  const line=source(), finished=add(line), pending=add(line,2);
  prepared("UPDATE image_jobs SET nextAt=NULL WHERE id=?").run(pending.id);
  remote.control.complete=true; worker.start();
  await wait(()=>phase(finished)).toBe("done");
  worker.stop(); await wait(()=>worker.busy).toBe(false);
  expedite(pending);
  const calls=remote.calls.length;
  environment=randomUUID(); await restart();
  await wait(()=>phase(pending)).toBe("failed");
  expect(remote.calls).toHaveLength(calls);
  expect(readMessage(line.thread,pending.card)?.imageJob?.reason).toBe("other_installation");
  expect(imageDownloadVisible(finished.attachment+".png",id=>id===line.thread)).toBe(true);
  expect(imageDownloadVisible(finished.attachment+".png",()=>false)).toBe(false);
});
