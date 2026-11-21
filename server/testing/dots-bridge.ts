import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { verificationServerArgs, verificationServerEnvironment } from "../../scripts/control-omb.ts";
import { createServer } from "node:http";
import { EventEmitter, once } from "node:events";
import type { DotsReceipt } from "../dots/client.ts";

export async function dotsBridgeFixture(loseFirstResponses = true) {
  const token = randomUUID();
  const gates = new EventEmitter();
  const pauseNext = (stage: "poll" | "upload") => ({
    started: once(gates, stage), release: () => gates.emit(stage + "-released"),
  });
  const waitIfPaused = async (stage: "poll" | "upload") => {
    if (!gates.listenerCount(stage)) return;
    const released = once(gates, stage + "-released");
    gates.emit(stage);
    await released;
  };
  type Send = { idempotency_key: string; correlation_id: string; text: string; artifact_ids: string[] };
  const attempts: string[] = [], sends = new Map<string, Send>(), events: DotsReceipt[] = [], uploaded: Buffer[] = [];
  let ack = 0, ackAttempts = 0, dropAck = loseFirstResponses, dropSubmit = loseFirstResponses, authorized = true, refusedPolls = 0;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://localhost");
    const json = (value: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    if (url.pathname === "/health") return json({ status: "ok" });
    if (!authorized || req.headers.authorization !== "Bearer " + token) {
      if (url.pathname.startsWith("/v1/events")) refusedPolls++;
      return json({ error: "invalid_host" }, 401);
    }
    const chunks: Buffer[] = [];
    for await (const bytes of req) chunks.push(Buffer.from(bytes));
    const body = Buffer.concat(chunks);
    if (url.pathname === "/v1/status") return json({ subscription: "active" });
    if (url.pathname === "/v1/events") {
      await waitIfPaused("poll");
      return json({ events: events.filter(e => e.sequence > ack) });
    }
    if (url.pathname === "/v1/events/ack") {
      ackAttempts++;
      if (dropAck) { dropAck = false; return res.destroy(); }
      ack = JSON.parse(body.toString()).sequence; return json({ cursor: ack });
    }
    if (url.pathname === "/v1/messages") {
      const send: Send = JSON.parse(body.toString()), id = "msg-" + send.idempotency_key;
      attempts.push(id);
      if (sends.has(id) && JSON.stringify(send) !== JSON.stringify(sends.get(id))) return json({ error: "conflict" }, 409);
      sends.set(id, send);
      if (dropSubmit) { dropSubmit = false; return res.destroy(); }
      return json({ id }, 202);
    }
    if (url.pathname.startsWith("/v1/messages/")) {
      const id = url.pathname.split("/").pop()!;
      return sends.has(id) ? json({ id, correlation_id: sends.get(id)!.correlation_id }) : json({ error: "not_found" }, 404);
    }
    if (url.pathname === "/v1/attachments") {
      await waitIfPaused("upload");
      uploaded.push(body); return json({ id: "up" + uploaded.length }, 201);
    }
    if (url.pathname === "/v1/attachments/remote-file") return res.end(Buffer.from("downloaded bytes"));
    return json({}, 404);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  return { cursor: () => ack, ackAttempts: () => ackAttempts, refusedPolls: () => refusedPolls, authorize: (allowed: boolean) => { authorized = allowed; }, port: (server.address() as { port: number }).port, token, attempts, sends, uploaded,
    pauseNext,
    event(e: Omit<DotsReceipt, "sequence" | "id">) {
      const number = events.length + 1; events.push({ ...e, sequence: number, id: "e" + number });
    },
    async close() { const closed = once(server, "close"); server.close(); server.closeAllConnections(); await closed; } };
}

export async function withRestartedDotsHost(info: { dataDir: string; url: string }, verify: () => Promise<void>, fixtureEnv: NodeJS.ProcessEnv = {}) {
  const env = verificationServerEnvironment(fixtureEnv, info.dataDir, Number(new URL(info.url).port));
  const child = spawn(process.execPath, verificationServerArgs(env), { env, stdio: "ignore" });
  try {
    const deadline = AbortSignal.timeout(15_000);
    while (!(await fetch(info.url + "/api/health", { signal: deadline }).catch(() => null))?.ok) {
      deadline.throwIfAborted();
      await delay(100, undefined, { signal: deadline });
    }
    await verify();
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit"); child.kill("SIGTERM"); await exited;
    }
  }
}
