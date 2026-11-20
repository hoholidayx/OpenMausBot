import { expect, it, vi } from "vitest";
import { runDreamTextTools, type DreamRequest } from "./dream-tools.ts";

it("dispatches only named entry tools on a text-only engine and feeds their result back", async () => {
  const request: DreamRequest = { system: "role and criteria", input: "batch", checkpoint: vi.fn(), execute: vi.fn(() => "updated one entry") };
  const generate = vi.fn().mockResolvedValueOnce('{"calls":[{"name":"core_update","arguments":{"oldText":"early","text":"late"}}]}').mockResolvedValueOnce('{"calls":[]}');
  await runDreamTextTools(request, generate, { model: "chosen" });
  expect(request.execute).toHaveBeenCalledWith("core_update", { oldText: "early", text: "late" });
  expect(generate.mock.calls[1][0]).toContain("updated one entry");
  expect(generate.mock.calls[1][1]).toEqual({ model: "chosen" });
  for (const reply of ['{"calls":[{"name":"memory_add","arguments":{}}]}', 'full Markdown replacement', '{}']) {
    await expect(runDreamTextTools(request, async () => reply, {})).rejects.toThrow();
  }
  expect(request.execute).toHaveBeenCalledTimes(1);
});
