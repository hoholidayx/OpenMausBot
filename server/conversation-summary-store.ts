import { prepared } from "./message-db.ts";

export interface ConversationSummary {
  scope: string;
  through: string;
  fingerprint: string;
  summary: string;
}

export const conversationSummaries = {
  read(threadId: string, botId: string): ConversationSummary | undefined {
    return prepared("SELECT scope, through, fingerprint, summary FROM conversation_summaries WHERE thread_id = ? AND bot_id = ?")
      .get(threadId, botId) as ConversationSummary | undefined;
  },
  save(threadId: string, botId: string, row: ConversationSummary): void {
    prepared(`INSERT INTO conversation_summaries (thread_id, bot_id, scope, through, fingerprint, summary) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (thread_id, bot_id) DO UPDATE SET scope=excluded.scope, through=excluded.through,
      fingerprint=excluded.fingerprint, summary=excluded.summary`)
      .run(threadId, botId, row.scope, row.through, row.fingerprint, row.summary);
  },
  forget(threadId: string, botId?: string): void {
    if (botId === undefined) prepared("DELETE FROM conversation_summaries WHERE thread_id = ?").run(threadId);
    else prepared("DELETE FROM conversation_summaries WHERE thread_id = ? AND bot_id = ?").run(threadId, botId);
  },
  forgetBot(botId: string): void {
    prepared("DELETE FROM conversation_summaries WHERE bot_id = ?").run(botId);
  },
};
