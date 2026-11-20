import { prepared } from "./message-db.ts";

type Position = { at: number; seq: number; threadId: string; id: string; offset: number };
type Cursor = Position & { afterSeq: number; throughSeq: number };
type ChatRow = Omit<Position, "offset"> & { speaker: string; role: string; fragment: string };
type ChatLine = { thread: string; at: number; role: string; speaker: string; text: string; continued?: boolean };
export type DreamBatch = { lines: ChatLine[]; through: Cursor };

const beginning = { at: Number.MIN_SAFE_INTEGER, seq: 0, threadId: "", id: "", offset: 0 };

function cursorFor(id: string): Cursor | undefined {
  return prepared(`SELECT at, seq, thread_id AS threadId, message_id AS id, offset, after_seq AS afterSeq, through_seq AS throughSeq
    FROM dream_cursors WHERE bot_id = ?`).get(id) as Cursor | undefined;
}

export function saveDreamCursor(botId: string, cursor: Cursor) {
  prepared(`INSERT OR REPLACE INTO dream_cursors(bot_id, at, seq, thread_id, message_id, offset, after_seq, through_seq)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(botId, cursor.at, cursor.seq, cursor.threadId, cursor.id, cursor.offset, cursor.afterSeq, cursor.throughSeq);
}

/** SQLite substr counts Unicode code points. The cursor and the fixture replay use the same unit. */
export function nextDreamBatch(botId: string, threads: string[], budget: number): DreamBatch | null {
  if (!threads.length) return null;
  const newest = (prepared("SELECT COALESCE(MAX(rowid), 0) AS n FROM messages").get() as { n: number }).n;
  const cursor = cursorFor(botId);
  if (cursor) {
    const rest = readBatch(cursor, threads, budget);
    if (rest || newest <= cursor.throughSeq) return rest;
  }
  const snapshot = { ...beginning, afterSeq: cursor?.throughSeq ?? 0, throughSeq: newest };
  const batch = readBatch(snapshot, threads, budget);
  if (batch) saveDreamCursor(botId, snapshot);
  return batch;
}

function readBatch(cursor: Cursor, threads: string[], budget: number): DreamBatch | null {
  const rows = prepared(`SELECT at, rowid AS seq, thread_id AS threadId, id, role,
      substr(COALESCE(json_extract(json, '$.from.name'), json_extract(json, '$.sender.name'), role), 1, 100) AS speaker,
      substr(text, CASE WHEN rowid = ? THEN ? + 1 ELSE 1 END, ?) AS fragment
    FROM messages WHERE thread_id IN (SELECT value FROM json_each(?))
      AND kind = 'text' AND role IN ('user','bot') AND text IS NOT NULL AND text <> ''
      AND json_extract(json, '$.setupOffer') IS NOT 1
      AND (role = 'bot' OR (json_extract(json, '$.peerAsk') IS NULL AND json_extract(json, '$.automated') IS NOT 1 AND json_extract(json, '$.aside') IS NOT 1))
      AND rowid > ? AND rowid <= ? AND (at, rowid) >= (?, ?)
    ORDER BY at, rowid LIMIT 64`).iterate(cursor.seq, cursor.offset, budget + 1, JSON.stringify(threads), cursor.afterSeq, cursor.throughSeq, cursor.at, cursor.seq + (cursor.offset ? 0 : 1));
  let through: Position | undefined;
  let remaining = budget;
  const lines: ChatLine[] = [];
  for (const raw of rows) {
    const { at, seq, threadId, id, role, speaker, fragment } = raw as ChatRow;
    const offset = seq === cursor.seq ? cursor.offset : 0;
    const line: ChatLine = { thread: threadId, at, role, speaker, text: fragment, ...(offset ? { continued: true } : {}) };
    const size = (text: string) => Buffer.byteLength(JSON.stringify({ ...line, text })) + 1;
    if (size(fragment) > remaining) {
      const chars = Array.from(fragment);
      let lo = 0, hi = chars.length;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (size(chars.slice(0, mid).join("")) <= remaining) lo = mid;
        else hi = mid - 1;
      }
      if (!lo) break;
      lines.push({ ...line, text: chars.slice(0, lo).join("") });
      through = { at, seq, threadId, id, offset: offset + lo };
      break;
    }
    if (fragment) {
      lines.push(line);
      remaining -= size(fragment);
    }
    through = { at, seq, threadId, id, offset: 0 };
  }
  return through ? { lines, through: { ...through, afterSeq: cursor.afterSeq, throughSeq: cursor.throughSeq } } : null;
}
