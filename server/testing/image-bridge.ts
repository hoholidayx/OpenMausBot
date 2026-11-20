import { createHash } from "node:crypto";
import { startFakeHttpMcp } from "./fake-http-mcp-server.ts";

export const fixturePng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const tools = { image_submit: ["request_id", "prompt"], image_status: ["task_id"], image_result: ["task_id"] };
export async function fixtureImageBridge(png = fixturePng) {
  const sha256 = createHash("sha256").update(png).digest("hex");
  const tasks = new Map<string, string>();
  const failures = new Map<string, string>();
  const calls: Array<{ name: string; id: string }> = [];
  const control = { complete: false, refusal: "", badDigest: false, loseReceipt: false };
  const error = (error_code: string) => ({ isError: true, content: [], structuredContent: { error_code } });
  const remote = await startFakeHttpMcp({
    pageSize: 2,
    tools: [
      { name: "info", inputSchema: { type: "object" } },
      ...Object.entries(tools).map(([name, keys]) => ({
        name,
        inputSchema: {
          type: "object",
          required: keys,
          additionalProperties: false,
          properties: Object.fromEntries(
            (name === "image_submit" ? [...keys, "size"] : keys).map((k) => [k, { type: "string" }]),
          ),
        },
      })),
    ],
    callResult(params) {
      const { name, arguments: args } = params as { name: string; arguments: Record<string, string> };
      const id = args.request_id ?? args.task_id;
      calls.push({ name, id });
      if (control.refusal && name === "image_submit") return error(control.refusal);
      if (name === "image_submit" && !tasks.has(id)) tasks.set(id, "queued");
      if (name === "image_submit" && control.loseReceipt) {
        control.loseReceipt = false;
        return { content: [] };
      }
      if (!tasks.has(id)) return error("task_not_found");
      const state = control.complete ? "completed" : tasks.get(id);
      if (name !== "image_result")
        return { structuredContent: { task_id: id, state, error_code: failures.get(id) }, content: [] };
      if (state !== "completed") return error("result_not_ready");
      return {
        structuredContent: {
          task_id: id,
          width: png.readUInt32BE(16),
          height: png.readUInt32BE(20),
          seed_used: "18446744073709551615",
          sha256: control.badDigest ? "a".repeat(64) : sha256,
        },
        content: [{ type: "image", mimeType: "image/png", data: png.toString("base64") }],
      };
    },
  });
  return { tasks, failures, calls, control, url: remote.url, close: remote.close, sha256 };
}
