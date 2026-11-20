import type { ToolCallContext, ToolCallResult } from "./agents-call.ts";
import type { Json } from "./agents-client.ts";

export const IMAGE_PROMPT_MAX_CHARS = 4000;
export const IMAGE_TOOL_NAMES: ReadonlySet<string> = new Set(["generate_image", "generate_image_async"]);

export async function callImageTool(name: string, args: Json, context: ToolCallContext): Promise<ToolCallResult> {
  const { ok, body } = await context.client.apiResponse(name === "generate_image_async" ? "/api/internal/images/enqueue" : "/api/internal/images/generate", {
    method: "POST",
    body: JSON.stringify({ fromBotId: context.botId, fromThreadId: context.threadId, ...args }),
  });
  return ok ? { text: String(body.text ?? "") } : { text: String(body.error ?? "The image was not generated. Try again shortly."), isError: true };
}

export const IMAGE_TOOL_DEFINITIONS = [
  {
    name: "generate_image_async",
    description: "Queue one image for this private chat. An accepted request will deliver its picture to the original message automatically. Finish this reply after acceptance. For several requested pictures use consecutive image_index values starting at 1.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["prompt"],
      properties: {
        prompt: { type: "string", minLength: 1, maxLength: IMAGE_PROMPT_MAX_CHARS },
        size: { type: "string", description: "Optional auto, supported aspect ratio, or WIDTHxHEIGHT." },
        image_index: { type: "integer", minimum: 1, maximum: 10 },
      },
    },
  },
  {
    name: "generate_image",
    description:
      "Create one image from a text description with the person's image provider; it is attached to your reply when the turn ends, so do not describe or link it again. Write the prompt in English, concrete and visual. Name a provider only when the person asked for that one.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        prompt: { type: "string", minLength: 1, maxLength: IMAGE_PROMPT_MAX_CHARS, description: "What the image shows: subject, setting, style, lighting." },
        aspect: { type: "string", enum: ["1:1", "16:9", "9:16"], description: "Shape; square when omitted." },
        provider: { type: "string", enum: ["openai", "xai", "gemini", "openrouter", "custom"], description: "Only when the person named one; it must be their base or backup." },
      },
      required: ["prompt"],
    },
  },
];
