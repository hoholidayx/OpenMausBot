import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import { z } from "zod";
import { IMAGE_MAX_BYTES } from "./attachments.ts";
import type { RemoteMcpSpec } from "./contracts.ts";
import { decodeGeneratedImage } from "./generated-image.ts";
import { McpHttpError, RemoteMcpClient } from "./mcp-http.ts";

export const imageRequest = z.object({
  prompt: z.string().trim().min(1).max(4000),
  size: z.string().max(16).regex(/^(?:auto|1:1|2:3|3:2|3:4|4:3|9:16|16:9|21:9|\d{2,4}x\d{2,4})$/).refine(value =>
    !value.includes("x") || value.split("x").every(axis => +axis >= 64 && +axis <= 2048 && +axis % 32 === 0)).default("auto"),
  image_index: z.number().int().min(1).max(10).default(1),
});

const resultFrame = z.object({
  isError: z.boolean().optional(), structuredContent: z.record(z.string(), z.unknown()), content: z.array(z.unknown()).optional(),
});
const state = z.enum(["pending", "submitting", "queued", "running", "completed", "failed", "expired", "submission_uncertain"]);
const imageState = z.object({ task_id: z.string(), state, error_code: z.string().optional() });
const metadata = z.object({ task_id: z.string(), width: z.number().int().positive(), height: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), seed_used: z.string().regex(/^\d{1,20}$/).optional() });
const safeCodes = new Set(["invalid_request", "request_conflict", "queue_full", "backend_unavailable", "worker_unavailable",
  "task_not_found", "result_not_ready", "result_expired", "output_unavailable", "output_invalid", "generation_failed",
  "provider_auth", "provider_quota", "provider_rate_limited", "provider_policy", "provider_model_unavailable"]);
export const safeImageError = (code?: string) => code && safeCodes.has(code) ? code : "generation_failed";

export class ImageBridgeError extends Error {}
export const imageDigest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

function validPng(bytes: Buffer, width: number, height: number) {
  if (width > 8192 || height > 8192 || width * height > 32_000_000 || bytes.length < 45 ||
      bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR" ||
      bytes.readUInt32BE(16) !== width || bytes.readUInt32BE(20) !== height) return false;
  let data = false;
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length || crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) return false;
    const kind = bytes.toString("ascii", offset + 4, offset + 8);
    if (kind === "IEND") return data && length === 0 && end === bytes.length;
    if (kind === "IDAT" && length > 0) data = true;
    offset = end;
  }
  return false;
}

export class ImageBridge {
  private readonly client: RemoteMcpClient;
  private readonly signal: AbortSignal;
  constructor(target: RemoteMcpSpec, stop: AbortSignal) {
    this.signal = AbortSignal.any([stop, AbortSignal.timeout(30_000)]);
    this.client = new RemoteMcpClient(target, { maxBytes: Math.ceil(IMAGE_MAX_BYTES / 3) * 4 + 128 * 1024,
      fetch: (url, init) => fetch(url, { ...init, redirect: "error" }) });
  }
  async open() { await this.client.initialize("openmausbot-image", this.signal); }
  close() { return this.client.close(); }
  async check() {
    const list = z.object({ tools: z.array(z.object({ name: z.string(), inputSchema: z.object({
      properties: z.record(z.string(), z.unknown()), required: z.array(z.string()).optional(),
    }) })) }).parse(await this.client.request("tools/list", {}, this.signal));
    for (const [name, keys] of Object.entries({ image_submit: ["request_id", "prompt"], image_status: ["task_id"], image_result: ["task_id"] })) {
      const schema = list.tools.find(tool => tool.name === name)?.inputSchema;
      if (!schema || !keys.every(key => key in schema.properties) || schema.required?.some(key => !keys.includes(key))) {
        throw new ImageBridgeError("invalid_contract");
      }
    }
  }
  private async call(name: string, args: Record<string, string>) {
    let raw: unknown;
    try { raw = await this.client.request("tools/call", { name, arguments: args }, this.signal); }
    catch (e) {
      if (e instanceof McpHttpError && e.kind === "protocol" && /exceeds|too large/i.test(e.message)) throw new ImageBridgeError("output_invalid");
      throw e;
    }
    const parsed = resultFrame.safeParse(raw);
    if (!parsed.success) throw new ImageBridgeError("invalid_contract");
    if (parsed.data.isError) throw new ImageBridgeError(safeImageError(String(parsed.data.structuredContent.error_code)));
    return parsed.data;
  }
  async observe(id: string, submit?: { prompt: string; size: string }) {
    const reply = submit ? await this.call("image_submit", { request_id: id, prompt: submit.prompt, ...(submit.size === "auto" ? {} : { size: submit.size }) })
      : await this.call("image_status", { task_id: id });
    const parsed = imageState.safeParse(reply.structuredContent);
    if (!parsed.success || parsed.data.task_id !== id) throw new ImageBridgeError("invalid_contract");
    return parsed.data;
  }
  async result(id: string) {
    const reply = await this.call("image_result", { task_id: id });
    const info = metadata.safeParse(reply.structuredContent);
    const content = z.tuple([z.object({ type: z.literal("image"), mimeType: z.literal("image/png"), data: z.string() })]).safeParse(reply.content);
    if (!info.success || info.data.task_id !== id || !content.success) throw new ImageBridgeError("output_invalid");
    try {
      const { bytes, mime } = decodeGeneratedImage(content.data[0].data);
      if (mime !== "image/png" || !validPng(bytes, info.data.width, info.data.height) ||
          bytes.toString("base64") !== content.data[0].data || imageDigest(bytes) !== info.data.sha256) {
        throw new Error();
      }
      return { bytes, digest: info.data.sha256 };
    } catch { throw new ImageBridgeError("output_invalid"); }
  }
}
