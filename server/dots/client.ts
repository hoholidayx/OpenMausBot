import { readFileSync } from "node:fs";
import { z } from "zod";

const id = z.string().min(1).max(256);
const archive = z.object({
  id, name: z.string().nullish(), status: z.enum(["pending", "ready", "missing"]),
  size: z.number().nonnegative().nullish(), sha256: z.string().nullish(),
});

export const receiptSchema = z.object({
  sequence: z.number().int().positive(), id, kind: id, text: z.string().nullish(),
  message_id: id.nullish(), correlation_id: id.nullish(), request_id: id.nullish(),
  artifact_ids: z.array(id).optional(), attachments: z.array(archive).optional(),
  artifact_id: id.optional(), filename: z.string().optional(), size: z.number().optional(),
  problem: z.string().nullish(), reason: z.string().nullish(),
});

export type DotsReceipt = z.infer<typeof receiptSchema>;
export type DotsStatus = { connected: boolean; authorized: boolean; subscription: string };
export class DotsHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export class DotsClient {
  private readonly url: string;
  private readonly tokenFile: string;
  constructor(port: number, tokenFile: string) {
    this.tokenFile = tokenFile;
    this.url = `http://127.0.0.1:${port}`;
  }

  private async request(path: string, signal: AbortSignal, init?: RequestInit) {
    let token: string;
    try { token = readFileSync(this.tokenFile, "utf8").trim(); } catch { throw new DotsHttpError(401, "Dots host credential unavailable."); }
    if (!token) throw new DotsHttpError(401, "Dots host credential is empty.");
    const headers = new Headers(init?.headers);
    headers.set("authorization", "Bearer " + token);
    const response = await fetch(this.url + path, { ...init, headers, redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(35_000)]) });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: unknown };
      throw new DotsHttpError(response.status, typeof body.error === "string" ? body.error : `Dots HTTP ${response.status}`);
    }
    return response;
  }

  async status(signal: AbortSignal): Promise<DotsStatus> {
    try {
      const data = await (await this.request("/v1/status", signal)).json() as { subscription?: string };
      return { connected: true, authorized: true, subscription: data.subscription ?? "unknown" };
    } catch {
      const connected = await fetch(this.url + "/health", { redirect: "error", signal }).then(async response => {
        await response.body?.cancel();
        return response.ok;
      }).catch(() => false);
      return { connected, authorized: false, subscription: "unknown" };
    }
  }

  async submit(key: string, text: string, artifactIds: string[], signal: AbortSignal) {
    const response = await this.request("/v1/messages", signal, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ idempotency_key: key, correlation_id: key, text, artifact_ids: artifactIds }),
    });
    return z.object({ id }).parse(await response.json()).id;
  }

  async message(localId: string, signal: AbortSignal) {
    const response = await this.request("/v1/messages/" + encodeURIComponent(localId), signal);
    return z.object({ id, correlation_id: id.nullish() }).parse(await response.json());
  }

  async events(signal: AbortSignal) {
    const response = await this.request("/v1/events?wait=25", signal);
    return z.object({ events: z.array(receiptSchema) }).parse(await response.json()).events;
  }

  async acknowledge(sequence: number, signal: AbortSignal) {
    const response = await this.request("/v1/events/ack", signal, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sequence }) });
    await response.arrayBuffer();
  }

  async upload(name: string, mime: string, bytes: Uint8Array<ArrayBuffer>, signal: AbortSignal) {
    const response = await this.request("/v1/attachments?filename=" + encodeURIComponent(name), signal,
      { method: "POST", headers: { "content-type": mime }, body: bytes });
    return z.object({ id }).parse(await response.json()).id;
  }

  download(fileId: string, signal: AbortSignal) {
    return this.request("/v1/attachments/" + encodeURIComponent(fileId), signal);
  }
}
