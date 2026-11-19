import { usageCount } from "./drivers/openai-usage.ts";

const HANDOFF_RESULT_LIMIT = 12_000;

export type ProviderOutputLimit = (reason: "length" | "max_output_tokens", replyChars: number, outputTokens?: number) => void;

export function traceProviderFinish(trace: ProviderOutputLimit | undefined, reason: unknown, reply: string,
  usage?: { completion_tokens?: unknown; output_tokens?: unknown }) {
  if (reason !== "length" && reason !== "max_output_tokens") return;
  const tokens = usage?.output_tokens ?? usage?.completion_tokens;
  trace?.(reason, reply.length, usageCount(tokens));
}

export function clipHandoffResult(text: string, context: {
  stage: "turn-outcome" | "assignment-result";
  threadId: string; turnId?: string; assignmentId?: string;
}): string {
  if (text.length <= HANDOFF_RESULT_LIMIT) return text;
  console.warn("output_truncation", JSON.stringify({ ...context, originalChars: text.length, retainedChars: HANDOFF_RESULT_LIMIT }));
  return text.slice(0, HANDOFF_RESULT_LIMIT);
}
