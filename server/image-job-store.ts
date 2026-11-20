import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { IMAGE_DAILY_CAP, IMAGE_DAY_FILE, localDay } from "./image-daily-cap.ts";
import { prepared, transaction } from "./message-db.ts";

export type ImagePhase = "queued" | "submitting" | "polling" | "fetching" | "done" | "failed" | "review";
export interface ImageJob {
  id: string; environment: string; bot: string; thread: string; source: string; slot: number; turn: string;
  card: string; attachment: string; server: string; fingerprint: string; paramsHash: string; prompt: string; size: string;
  phase: ImagePhase; day: string; nextAt: number | null; claim: string; errors: number; troubleSince: number; digest: string;
}
export type ImageJobUpdate = Pick<ImageJob, "phase" | "nextAt"> & Partial<Pick<ImageJob, "prompt" | "digest" | "errors" | "troubleSince">>;

export function claimImageQuota(environment: string, dataDir: string, day: string) {
  return transaction(() => {
    if (!prepared("SELECT 1 FROM image_days WHERE environment=? AND day=?").get(environment, day)) {
      let used = 0;
      try {
        const prior = JSON.parse(readFileSync(join(dataDir, IMAGE_DAY_FILE), "utf8"));
        if (prior?.day === day && Number.isSafeInteger(prior.count)) used = Math.max(0, prior.count);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      prepared("INSERT INTO image_days VALUES (?, ?, ?)").run(environment, day, used);
    }
    return Boolean(prepared("UPDATE image_days SET used=used+1 WHERE environment=? AND day=? AND used<?").run(environment, day, IMAGE_DAILY_CAP).changes);
  });
}
export function releaseImageQuota(environment: string, day: string) {
  prepared("UPDATE image_days SET used=max(used-1,0) WHERE environment=? AND day=?").run(environment, day);
}
export function syncImageReservation(environment: string, dataDir: string) {
  const day = localDay(new Date());
  return claimImageQuota(environment, dataDir, day) ? (made: boolean) => { if (!made) releaseImageQuota(environment, day); } : null;
}

export function findImageJob(environment: string, bot: string, thread: string, source: string, slot: number) {
  return prepared("SELECT * FROM image_jobs WHERE environment=? AND bot=? AND thread=? AND source=? AND slot=?")
    .get(environment, bot, thread, source, slot) as unknown as ImageJob | undefined;
}
export function saveImageJob(job: ImageJob) {
  prepared(`INSERT INTO image_jobs(id,environment,bot,thread,source,slot,turn,card,attachment,server,fingerprint,paramsHash,prompt,size,phase,day,nextAt)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(job.id,job.environment,job.bot,job.thread,job.source,job.slot,job.turn,job.card,job.attachment,
    job.server,job.fingerprint,job.paramsHash,job.prompt,job.size,job.phase,job.day,job.nextAt);
}
export function imageSlotsUsed(environment: string, thread: string, source: string) {
  return Number(prepared("SELECT count(*) AS n FROM image_jobs WHERE environment=? AND thread=? AND source=? AND phase!='failed'").get(environment,thread,source)?.n);
}
export function nextImageDue(environment: string) {
  return prepared("SELECT min(nextAt) AS at FROM image_jobs WHERE environment=? AND nextAt IS NOT NULL").get(environment)?.at as number | null;
}
export function claimImageJobs(environment: string, now: number) {
  return transaction(() => {
    const jobs = prepared("SELECT * FROM image_jobs WHERE environment=? AND nextAt<=? ORDER BY nextAt, rowid LIMIT 2").all(environment, now) as unknown as ImageJob[];
    for (const job of jobs) {
      job.claim = randomUUID();
      prepared("UPDATE image_jobs SET claim=?, nextAt=? WHERE id=?").run(job.claim, now + 65_000, job.id);
    }
    return jobs;
  });
}
export function updateImageJob(job: ImageJob, patch: ImageJobUpdate) {
  const changes = Object.entries(patch);
  const updated = prepared(`UPDATE image_jobs SET ${changes.map(([key]) => key + "=?").join(",")} WHERE id=? AND claim=?`)
    .run(...changes.map(([,value]) => value), job.id, job.claim);
  if (!updated.changes) throw new Error("Image task claim expired");
  Object.assign(job, patch);
}
export function recheckImageJob(environment: string, thread: string, card: string) {
  return Boolean(prepared("UPDATE image_jobs SET phase='polling', errors=0, troubleSince=0, nextAt=0 WHERE environment=? AND thread=? AND card=? AND phase='review'")
    .run(environment, thread, card).changes);
}
export function pendingImageFiles() {
  return prepared("SELECT attachment FROM image_jobs WHERE phase='fetching'").all().map(row => String(row.attachment) + ".png");
}
export function imageDownloadVisible(name: string, visible: (thread: string) => boolean) {
  const state = imageFileState(name);
  if (!state) return true;
  if (state !== "done") return false;
  const threads = prepared("SELECT DISTINCT m.thread_id FROM messages m, json_each(m.json,'$.attachments') a WHERE instr(m.json, ?) > 0 AND json_extract(a.value,'$.kind')='image' AND substr(json_extract(a.value,'$.path'), -length(?))=?")
    .all(name, "/" + name, "/" + name);
  return threads.some(row => visible(String(row.thread_id)));
}
export function imageFileState(name: string) {
  if (!name.endsWith(".png")) return undefined;
  return prepared("SELECT phase FROM image_jobs WHERE attachment=?").get(name.slice(0, -4))?.phase as ImagePhase | undefined;
}
