import { randomUUID, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { Message } from "../store.ts";
import type { DotsReceipt } from "./client.ts";
import type { DotsUpload } from "./files.ts";

export interface DotsTurn {
  id: string;
  threadId: string;
  sourceId: string;
  rootId: string;
  parent?: { botId: string; threadId: string; messageId: string };
  text: string;
  files: DotsUpload[];
}
type JobRow = { input: string; uploaded: string; local: string | null; stopped: number; result: string | null };
export type DotsJob = ReturnType<typeof job>;
function job(row: JobRow) {
  return { turn: JSON.parse(row.input) as DotsTurn, uploaded: JSON.parse(row.uploaded) as string[], local: row.local,
    stopped: Boolean(row.stopped), result: row.result ? JSON.parse(row.result) as DotsReceipt : null };
}
type DotsFile = NonNullable<Message["dotsFiles"]>[number];

export class DotsInbox {
  private readonly db: DatabaseSync;
  readonly botId: string;
  readonly threadId: string;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS identity (bot TEXT NOT NULL, thread TEXT NOT NULL, installed INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS binding_owner (singleton INTEGER PRIMARY KEY CHECK (singleton=1), digest TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS grants (send TEXT NOT NULL, thread TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(thread,send));
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, root TEXT NOT NULL, input TEXT NOT NULL, uploaded TEXT NOT NULL DEFAULT '[]',
        local TEXT UNIQUE, stopped INTEGER DEFAULT 0, due INTEGER DEFAULT 0, result TEXT);
      CREATE INDEX IF NOT EXISTS job_root ON jobs(root);
      CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, payload TEXT NOT NULL, op TEXT, applied INTEGER DEFAULT 0);
      CREATE INDEX IF NOT EXISTS pending_projection ON receipts(applied);
      CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, name TEXT, status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS receipt_files (file TEXT NOT NULL, event TEXT NOT NULL, PRIMARY KEY(file,event));`);
    let identity = this.db.prepare("SELECT bot,thread FROM identity").get();
    if (!identity) {
      identity = { bot: randomUUID(), thread: randomUUID() };
      this.db.prepare("INSERT INTO identity(bot,thread) VALUES (?,?)").run(identity.bot, identity.thread);
    }
    this.botId = String(identity.bot);
    this.threadId = String(identity.thread);
  }

  ownerMatches(key: string, legacyKey?: string | null) {
    const digest = createHash("sha256").update(key).digest("hex");
    const owner = this.db.prepare("SELECT digest FROM binding_owner WHERE singleton=1").get();
    if (owner) {
      if (owner.digest === digest) return true;
      if (!legacyKey || owner.digest !== createHash("sha256").update(legacyKey).digest("hex")) return false;
      return this.db.prepare("UPDATE binding_owner SET digest=? WHERE singleton=1 AND digest=?").run(digest, owner.digest).changes === 1;
    }
    if (legacyKey === null) return false;
    this.db.prepare("INSERT INTO binding_owner VALUES(1,?)").run(digest);
    return true;
  }

  get installed() {
    return !!this.db.prepare("SELECT 1 FROM identity WHERE installed=1").get();
  }

  markInstalled() {
    this.db.prepare("UPDATE identity SET installed=1").run();
  }

  recordUploads(id: string, files: string[]) {
    this.db.prepare("UPDATE jobs SET uploaded=? WHERE id=?").run(JSON.stringify(files), id);
  }

  accepted(id: string, local: string) {
    this.db.prepare("UPDATE jobs SET local=? WHERE id=?").run(local, id);
  }

  retryLater(id: string) {
    this.db.prepare("UPDATE jobs SET due=? WHERE id=?").run(Date.now() + 3000, id);
  }

  stopWaiting(id: string) {
    this.db.prepare("UPDATE jobs SET stopped=1 WHERE id=?").run(id);
  }

  projectionOf(id: string) {
    return this.db.prepare("SELECT applied FROM receipts WHERE id=?").get(id)?.applied;
  }

  authorize(thread: string, send: string, text: string) {
    this.db.prepare("INSERT OR IGNORE INTO grants VALUES (?,?,?)").run(send, thread, createHash("sha256").update(text).digest("hex"));
  }

  authorized(thread: string, message: Message | undefined) {
    return !!message?.sendId && message.role === "user" && !message.automated && !message.relayed && !message.peerAsk && !message.via && !message.fromApp && !message.pointed && !message.aside &&
      !!this.db.prepare("SELECT 1 FROM grants WHERE thread=? AND send=? AND digest=?").get(thread, message.sendId,
        createHash("sha256").update(message.text ?? "").digest("hex"));
  }

  enqueue(turn: DotsTurn) {
    const input = JSON.stringify(turn);
    this.db.prepare("INSERT OR IGNORE INTO jobs(id,root,input) VALUES (?,?,?)").run(turn.id, turn.rootId, input);
    const saved = this.get(turn.id)!;
    if (JSON.stringify(saved.turn) !== input) throw new Error("Dots operation has different content.");
    return saved;
  }

  get(id: string) {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id=?").get(id);
    return row ? job(row as JobRow) : null;
  }

  forRoot(id: string) {
    const row = this.db.prepare("SELECT * FROM jobs WHERE root=?").get(id);
    return row ? job(row as JobRow) : null;
  }

  nextSend() {
    const row = this.db.prepare("SELECT * FROM jobs WHERE local IS NULL AND stopped=0 AND result IS NULL AND due<=? ORDER BY rowid LIMIT 1").get(Date.now());
    return row ? job(row as JobRow) : null;
  }

  operation(local: string) {
    return this.db.prepare("SELECT id FROM jobs WHERE local=?").get(local)?.id as string | undefined;
  }

  capture(receipt: DotsReceipt, op?: string) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const inserted = this.db.prepare("INSERT OR IGNORE INTO receipts(id,payload,op) VALUES (?,?,?)")
        .run(receipt.id, JSON.stringify(receipt), op ?? null);
      if (inserted.changes) {
        for (const id of receipt.artifact_ids ?? []) {
          const info = receipt.attachments?.find(file => file.id === id);
          this.file(id, info?.name, info?.status === "missing" ? "unavailable" : info?.status ?? "pending");
          this.db.prepare("INSERT OR IGNORE INTO receipt_files VALUES (?,?)").run(id, receipt.id);
        }
        if (receipt.artifact_id && receipt.kind.startsWith("attachment_")) {
          const state = receipt.kind === "attachment_ready" ? "ready" : receipt.kind === "attachment_unavailable" ? "unavailable" : "pending";
          this.file(receipt.artifact_id, receipt.filename, state);
        }
        if (op && receipt.message_id) this.db.prepare("UPDATE jobs SET local=coalesce(local,?) WHERE id=?").run(receipt.message_id, op);
        if (op && ["reply", "cancel", "failed", "expired"].includes(receipt.kind)) {
          this.db.prepare("UPDATE jobs SET result=? WHERE id=? AND result IS NULL").run(JSON.stringify(receipt), op);
        }
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  private file(id: string, name: string | null | undefined, status: DotsFile["status"]) {
    this.db.prepare(`INSERT INTO files VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET name=coalesce(excluded.name,files.name),
      status=CASE WHEN excluded.status='pending' THEN files.status ELSE excluded.status END`).run(id, name ?? null, status);
  }

  files(receipt?: DotsReceipt | null): DotsFile[] {
    return (receipt?.artifact_ids ?? []).map(id => {
      const row = this.db.prepare("SELECT name,status FROM files WHERE id=?").get(id)!;
      return { id, name: String(row.name || id), status: row.status as DotsFile["status"] };
    });
  }

  references(id: string) {
    return this.db.prepare("SELECT payload,op FROM receipts JOIN receipt_files ON receipts.id=receipt_files.event WHERE file=?")
      .all(id).map(row => ({ receipt: JSON.parse(String(row.payload)) as DotsReceipt, op: row.op as string | null }));
  }

  pending() {
    return this.db.prepare("SELECT payload,op FROM receipts WHERE applied=0 ORDER BY rowid LIMIT 100").all()
      .map(row => ({ receipt: JSON.parse(String(row.payload)) as DotsReceipt, op: row.op as string | null }));
  }

  applied(id: string, delivered: boolean) {
    this.db.prepare("UPDATE receipts SET applied=? WHERE id=?").run(delivered ? 1 : -1, id);
  }
}
