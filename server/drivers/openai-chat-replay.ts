import { createHash } from "node:crypto";
import type { ChatContextFootprint } from "../contracts.ts";
import type { ChatToolDefinition } from "./chat-mcp-tools.ts";
import type { OpenAIChatMessage } from "./openai-chat.ts";

export interface DeliveredUserMessage {
  text: string;
  sent: string;
  volatile?: string;
  after: string;
}

const MAX_REPLAY_EXTRA_BYTES = 24_000;
const MAX_DELIVERED_THREADS = 256;

export const fingerprint = (text: string) => createHash("sha256").update(text).digest("base64url");

export function rememberChatDelivery<T>(cache: Map<string, T>, key: string, value: T): void {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > MAX_DELIVERED_THREADS) cache.delete(cache.keys().next().value!);
}

export function replayDelivered(
  transcript: ReadonlyArray<{ role: "user" | "assistant"; text: string }>,
  records: readonly DeliveredUserMessage[],
): { content: Map<number, string>; matched: DeliveredUserMessage[]; volatile: string | undefined } {
  const found: Array<{ index: number; record: DeliveredUserMessage }> = [];
  let next = records.length - 1;
  for (let index = transcript.length - 1; index >= 0 && next >= 0; index--) {
    const message = transcript[index]!;
    if (message.role !== "user" || !message.text) continue;
    const after = index > 0 ? fingerprint(transcript[index - 1]!.text) : undefined;
    for (let at = next; at >= 0; at--) {
      const record = records[at]!;
      if (record.text !== message.text && !record.text.endsWith("\n\n" + message.text)) continue;
      if (after !== undefined && record.after !== after) continue;
      found.unshift({ index, record });
      next = at - 1;
      break;
    }
  }
  const content = new Map<number, string>();
  let volatile: string | undefined;
  let budget = MAX_REPLAY_EXTRA_BYTES;
  for (const { index, record } of found) {
    const extra = Buffer.byteLength(record.sent) - Buffer.byteLength(transcript[index]!.text);
    if (extra > budget) break;
    budget -= extra;
    content.set(index, record.sent);
    if (record.volatile !== undefined) volatile = record.volatile;
  }
  return { content, matched: found.map(({ record }) => record), volatile };
}

export function contextFootprint(messages: readonly OpenAIChatMessage[], tools: readonly ChatToolDefinition[]): ChatContextFootprint {
  const system = messages[0]?.role === "system" ? messages[0].content : null;
  const definitions = JSON.stringify(tools);
  let images = 0;
  const text = messages.map(message => !Array.isArray(message.content) ? message : {
    ...message,
    content: message.content.map(part => {
      if (part.type === "text") return part;
      images++;
      return { type: part.type };
    }),
  });
  return {
    base: fingerprint(JSON.stringify([system, definitions])),
    tokens: Math.ceil((Buffer.byteLength(JSON.stringify(text)) + Buffer.byteLength(definitions)) / 2) + images * 2048,
  };
}
