import { DREAM_ROUNDS, type DreamRequest } from "../dream-tools.ts";
import type { Completion, OpenAIChatMessage } from "./openai-chat.ts";
import { ChatProtocolError } from "./openai-chat-protocol.ts";

export async function runOpenAIDream(
  request: DreamRequest,
  complete: (messages: OpenAIChatMessage[]) => Promise<Completion>,
  assistantReply: (reply: Completion) => OpenAIChatMessage,
) {
  const messages: OpenAIChatMessage[] = [
    { role: "system", content: request.system },
    { role: "user", content: request.input },
  ];
  for (let round = 0; round < DREAM_ROUNDS; round++) {
    request.checkpoint();
    const reply = await complete(messages);
    if (!reply.toolCalls.length && reply.finishReason === "stop") return;
    if (!reply.toolCalls.length || (reply.finishReason !== "tool_calls" && reply.finishReason !== "stop")) {
      throw new ChatProtocolError("Dream received an incomplete tool decision");
    }
    messages.push(assistantReply(reply));
    for (const call of reply.toolCalls) {
      request.checkpoint();
      const content = request.execute(call.function.name, JSON.parse(call.function.arguments));
      messages.push({ role: "tool", tool_call_id: call.id, content });
    }
  }
  throw new ChatProtocolError("Dream reached its tool-round limit");
}
