import { z } from "zod";
import type { TextGenerationOptions } from "./contracts.ts";

export const DREAM_CRITERIA = `结合你的职责，读这批聊天和已有核心记忆。
为了下次陪伴得更自然，或派活时少问一次，有哪件事值得一直记住？

只记用户自己表达、下次仍适用的习惯、偏好和分工，每条一句。助手的建议不算用户的约定。
保留“这个项目”等范围。同一句里的临时安排只管当次，“我通常……”才描述日常习惯。
先核对已有条目。用户后来描述的习惯有变化，就更新原条，只写当前事实。同义跳过，明确取消则删除。
复杂细节和任务进度留在原处。用工具逐条修改；没有值得改的就结束。`;

const descriptions = {
  core_add: "Add one enduring fact in one sentence. Exact duplicates are skipped.",
  core_update: "Replace one complete entry. Copy oldText exactly from entries. Write only the currently valid fact, without a Markdown bullet.",
  core_remove: "Remove one uniquely matching complete entry. Copy oldText exactly.",
};
export const dreamTools = Object.entries(descriptions).map(([name, description]) => {
  const required = name === "core_add" ? ["text"] : name === "core_update" ? ["oldText", "text"] : ["oldText"];
  return { type: "function" as const, function: { name, description, parameters: {
    type: "object", required, additionalProperties: false, properties: Object.fromEntries(required.map(key => [key, { type: "string" }])),
  } } };
});

export interface DreamRequest {
  system: string;
  input: string;
  checkpoint(): void;
  execute(name: string, args: unknown): string;
}

export const DREAM_ROUNDS = 12;
const decisions = z.object({ calls: z.array(z.object({ name: z.enum(["core_add", "core_update", "core_remove"]), arguments: z.record(z.string(), z.unknown()) }).strict()).max(20) }).strict();

/** Isolated CLI helpers transport the same host tool calls and results as JSON. */
export async function runDreamTextTools(request: DreamRequest, generate: (prompt: string, options: TextGenerationOptions) => Promise<string>, options: TextGenerationOptions) {
  let prompt = [request.system, JSON.stringify(dreamTools), request.input,
    'Respond with a single JSON object {"calls":[{"name":"core_add","arguments":{"text":"..."}}]} to call tools, or {"calls":[]} to finish.'].join("\n");
  for (let round = 0; round < DREAM_ROUNDS; round++) {
    request.checkpoint();
    const reply = (await generate(prompt, options)).trim().replace(/^\x60\x60\x60(?:json)?\s*|\s*\x60\x60\x60$/g, "");
    const { calls } = decisions.parse(JSON.parse(reply));
    if (!calls.length) return;
    const results = calls.map(call => {
      request.checkpoint();
      return request.execute(call.name, call.arguments);
    });
    prompt += "\n" + JSON.stringify({ calls, results }) + "\nContinue or finish.";
  }
  throw new Error("Dream reached its tool-round limit");
}
