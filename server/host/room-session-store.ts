import { z } from "zod";

import { HANDED_MAX_IDS } from "../delta-context.ts";
import { prepared } from "../message-db.ts";

const id = z.string().min(1);
const receiptPayload = z.object({
  version: z.literal(1),
  fingerprint: id,
  history: id,
  earlier: z.array(id).max(HANDED_MAX_IDS),
  handed: z.object({ session: id, omitted: id.optional(), through: id.optional(), ids: z.array(id).max(HANDED_MAX_IDS) }),
});

export type RoomSessionReceipt = z.infer<typeof receiptPayload> & { instanceId: string };

export interface RoomSessionStore {
  take(threadId: string, botId: string): RoomSessionReceipt | undefined;
  save(threadId: string, botId: string, receipt: RoomSessionReceipt): void;
  ownsElsewhere(threadId: string, botId: string, instanceId: string, sessionId: string): boolean;
  forget(threadId: string, botId?: string): void;
  forgetBot(botId: string): void;
  forgetInstance(instanceId: string): void;
}

function take(threadId: string, botId: string): RoomSessionReceipt | undefined {
  const row = prepared("DELETE FROM room_sessions WHERE thread_id = ? AND bot_id = ? RETURNING instance_id, session_id, payload")
    .get(threadId, botId) as { instance_id: string; session_id: string; payload: string } | undefined;
  if (!row) return undefined;
  try {
    const receipt = receiptPayload.safeParse(JSON.parse(row.payload));
    if (receipt.success && receipt.data.handed.session === row.session_id) return { ...receipt.data, instanceId: row.instance_id };
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  return undefined;
}

export const roomSessionStore: RoomSessionStore = {
  take,
  save(threadId, botId, { instanceId, ...receipt }) {
    prepared(`INSERT INTO room_sessions (thread_id, bot_id, instance_id, session_id, payload) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (thread_id, bot_id) DO UPDATE SET instance_id=excluded.instance_id, session_id=excluded.session_id, payload=excluded.payload`)
      .run(threadId, botId, instanceId, receipt.handed.session, JSON.stringify(receipt));
  },
  ownsElsewhere(threadId, botId, instanceId, sessionId) {
    return prepared("SELECT 1 FROM room_sessions WHERE instance_id = ? AND session_id = ? AND (thread_id <> ? OR bot_id <> ?) LIMIT 1")
      .get(instanceId, sessionId, threadId, botId) !== undefined;
  },
  forget(threadId, botId) {
    if (botId === undefined) prepared("DELETE FROM room_sessions WHERE thread_id = ?").run(threadId);
    else prepared("DELETE FROM room_sessions WHERE thread_id = ? AND bot_id = ?").run(threadId, botId);
  },
  forgetBot(botId) {
    prepared("DELETE FROM room_sessions WHERE bot_id = ?").run(botId);
  },
  forgetInstance(instanceId) {
    prepared("DELETE FROM room_sessions WHERE instance_id = ?").run(instanceId);
  },
};
