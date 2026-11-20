import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { EventEmitter, once } from "node:events";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { fixture } from "../testing/direct-coordination-fixture.ts";
import type { DotsReceipt } from "./client.ts";
import { verificationServerArgs, verificationServerEnvironment } from "../../scripts/control-omb.ts";
import { openRuntimeStore } from "../runtime/store.ts";

async function endpoint() {
  const token = randomUUID();
  const polls = new EventEmitter();
  type Send = { idempotency_key: string; correlation_id: string; text: string; artifact_ids: string[] };
  const attempts: string[] = [], sends = new Map<string, Send>(), events: DotsReceipt[] = [], uploaded: Buffer[] = [];
  let ack = 0, ackAttempts = 0, dropAck = true, dropSubmit = true, authorized = true, refusedPolls = 0;
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
      if (polls.listenerCount("started")) {
        const released = once(polls, "release");
        polls.emit("started");
        await released;
      }
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
    if (url.pathname === "/v1/attachments") { uploaded.push(body); return json({ id: "up" + uploaded.length }, 201); }
    if (url.pathname === "/v1/attachments/remote-file") return res.end(Buffer.from("downloaded bytes"));
    return json({}, 404);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  return { cursor: () => ack, ackAttempts: () => ackAttempts, refusedPolls: () => refusedPolls, authorize: (allowed: boolean) => { authorized = allowed; }, port: (server.address() as { port: number }).port, token, attempts, sends, uploaded,
    pauseNextPoll() { return { started: once(polls, "started"), release: () => polls.emit("release") }; },
    event(e: Omit<DotsReceipt, "sequence" | "id">) {
      const number = events.length + 1; events.push({ ...e, sequence: number, id: "e" + number });
    },
    async close() { const closed = once(server, "close"); server.close(); server.closeAllConnections(); await closed; } };
}

async function withRestartedHost(info: { dataDir: string; url: string }, verify: () => Promise<void>) {
  const env = verificationServerEnvironment({}, info.dataDir, Number(new URL(info.url).port));
  const child = spawn(process.execPath, verificationServerArgs(env), { env, stdio: "ignore" });
  try {
    await expect.poll(async () => (await fetch(info.url + "/api/bots").catch(() => null))?.status, { timeout: 15000 }).toBe(200);
    await verify();
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit"); child.kill("SIGTERM"); await exited;
    }
  }
}

it("routes interleaved private partner work, unsolicited push and original files across a host restart", async () => {
  const local = await endpoint();
  try {
    await fixture(async f => {
      const bots = (await f.api("/api/bots?messages=0")).bots;
      const dots = bots.find((b: any) => b.modelSelection.instanceId === "dots");
      expect(dots).toMatchObject({ name: "Dots", visibility: "admins" });
      const path = "/api/bots/" + f.chief.id, thread = f.chief.activeTaskId, inbox = dots.threadId;
      const work = path + "/work-partner?threadId=" + thread;
      const send = (id: string, threadId: string, text: string) => f.api("/api/bots/" + id + "/messages", { threadId, text, sendId: randomUUID() });
      const rows = (t: string) => f.messages(t) as Promise<any[]>;
      expect((await f.api(work)).candidates.map((b: any) => b.id)).not.toContain(dots.id);
      await f.api(path, { visibility: "admins" }, "PATCH");
      await f.api(work, { expected: null, partnerId: dots.id }, "PUT");
      await f.api("/api/bots/" + f.lead.id, { visibility: "admins" }, "PATCH");
      await expect(f.api("/api/bots/" + f.lead.id + "/work-partner", { expected: null, partnerId: dots.id }, "PUT")).rejects.toThrow();
      expect(await f.api("/api/dots/status")).toEqual({ connected: true, authorized: true, subscription: "active" });
      const upload = async (name: string, body: string) => {
        const url = f.session.info.url;
        const r = await fetch(url + "/api/files?name=" + name, { method: "POST", headers: { origin: url, "content-type": "text/plain" }, body });
        expect(r.status).toBe(201);
        return (await r.json() as { path: string }).path;
      };
      const attached = await upload("work.txt", "forwarded bytes"), unused = await upload("private.txt", "not forwarded");
      f.plan[f.chief.id] = { turns: ["first", "second"].map(text => ({
        steps: [{ arguments: { bot_ids: [dots.id], message: text, ...(text === "first" ? { files: [attached] } : {}) } }], reply: "Dispatched " + text,
      })) };
      f.save();
      const first = (await send(f.chief.id, thread, 'First delegated job\n\n<attached-file path="' + attached + '" name="work.txt" />\n\n<attached-file path="' + unused + '" name="private.txt" />' )).message;
      await expect.poll(() => local.sends.size, { timeout: 14000 }).toBe(1);
      await expect.poll(() => local.attempts.length, { timeout: 6500 }).toBe(2);
      expect(local.attempts[0]).toBe(local.attempts[1]);
      await expect.poll(async () => (await rows(thread)).some(r => r.text === "Dispatched first")).toBe(true);
      const second = (await send(f.chief.id, thread, "Second delegated job")).message;
      await expect.poll(() => local.sends.size, { timeout: 14000 }).toBe(2);
      const [a, b] = [...local.sends.entries()];
      expect([a[1].text, b[1].text]).toEqual(["first", "second"]);
      local.event({ kind: "progress", text: "Checking bytes", message_id: a[0], correlation_id: a[1].correlation_id });
      local.event({ kind: "push", text: "Inbox only" });
      local.event({ kind: "reply", text: "NEEDS INPUT: literal reply?", message_id: b[0], correlation_id: b[1].correlation_id,
        artifact_ids: ["remote-file"], attachments: [{ id: "remote-file", name: "receipt.txt", status: "pending" }] });
      await expect.poll(async () => (await rows(thread)).find(r => r.replyToId === second.id && r.partnerResultId)?.text, { timeout: 10000 }).toBe("NEEDS INPUT: literal reply?");
      await expect.poll(async () => (await rows(inbox)).filter(r => r.text === "Inbox only").length).toBe(1);
      await f.api(work, { expected: dots.id, partnerId: null }, "PUT");
      const info = f.session.info, url = info.url;
      const olderRoot = f.nodes().find((n: any) => n.id === b[1].correlation_id).rootId;
      await expect.poll(() => f.nodes().filter((n: any) => n.rootId === olderRoot).map((n: any) => n.status), { timeout: 8000 }).toEqual(["completed", "completed"]);
      const exited = once(f.session.child, "exit"); f.session.child.kill("SIGKILL"); await exited;
      const history = openRuntimeStore(join(info.dataDir, "runtime.db"));
      try {
        history.prune(Date.now() + 1);
        expect(history.get(b[1].correlation_id)).toBeUndefined();
      } finally { history.close(); }
      local.event({ kind: "reply", text: "", message_id: a[0], artifact_ids: ["remote-file"], attachments: [{ id: "remote-file", name: "receipt.txt", status: "pending" }] });
      await withRestartedHost(info, async () => {
        const result = async () => (await rows(thread)).filter(r => r.partnerResultId && r.replyToId === first.id);
        await expect.poll(async () => (await result()).length, { timeout: 15000 }).toBe(1);
        const item = (await result())[0];
        expect(item).toMatchObject({ from: { botId: dots.id }, dotsFiles: [{ id: "remote-file", status: "pending" }] });
        local.event({ kind: "attachment_ready", artifact_id: "remote-file", filename: "receipt.txt" });
        await expect.poll(async () => (await result())[0].dotsFiles[0].status).toBe("ready");
        const file = (t: string, id: string) => fetch(url + "/api/threads/" + t + "/messages/" + id + "/dots-files/remote-file");
        expect(await (await file(thread, item.id)).text()).toBe("downloaded bytes");
        const older = (await rows(thread)).find(r => r.partnerResultId === b[1].correlation_id);
        expect(older.dotsFiles[0].status).toBe("ready");
        expect(await (await file(thread, older.id)).text()).toBe("downloaded bytes");
        expect((await file(inbox, item.id)).status).toBe(404);
        const pairing = await f.api("/api/auth/pairing", { scopes: ["client"] });
        const paired = await f.api("/api/auth/pair", { code: pairing.code });
        const foreign = await fetch(url + "/api/threads/" + thread + "/messages/" + item.id + "/dots-files/remote-file", { headers: { authorization: "Bearer " + paired.token } });
        expect([403, 404]).toContain(foreign.status);
        expect((await rows(thread)).some(r => r.text === "Inbox only")).toBe(false);
        expect((await rows(item.threadRef.threadId)).some(r => r.tool?.name === "Checking bytes")).toBe(true);
        expect(f.evidence().filter((e: any) => e.botId === f.chief.id)).toHaveLength(2);
        const filePath = await upload("report.txt", "original bytes");
        const direct = await send(dots.id, inbox, '<attached-file path="' + filePath + '" name="report.txt" />');
        await expect.poll(() => local.sends.size, { timeout: 8000 }).toBe(3);
        const [key, last] = [...local.sends].at(-1)!;
        expect(last).toMatchObject({ text: "", artifact_ids: ["up2"] });
        expect(local.uploaded.map(b => b.toString())).toEqual(["forwarded bytes", "original bytes"]);
        local.event({ kind: "reply", message_id: key, correlation_id: last.correlation_id, text: "Direct answer" });
        await expect.poll(async () => (await rows(inbox)).filter(r => r.replyToId === direct.message.id && r.text === "Direct answer").length).toBe(1);
        expect((await result()).length).toBe(1);
        await expect(send(dots.id, item.threadRef.threadId, "wrong thread")).rejects.toThrow();
        await f.api(path, { visibility: "everyone" }, "PATCH");
        expect((await file(thread, older.id)).status).toBe(404);
      });
    }, {}, local);
  } finally { await local.close(); }
}, 95000);

it("holds late work after cancellation or a privacy change and resumes a revoked inbox without guessing an origin", async () => {
  const local = await endpoint();
  try {
    await fixture(async f => {
      const dots = (await f.api("/api/bots?messages=0")).bots.find((b: any) => b.modelSelection.instanceId === "dots");
      const path = "/api/bots/" + f.chief.id, thread = f.chief.activeTaskId;
      await f.api(path, { visibility: "admins" }, "PATCH");
      await f.api(path + "/work-partner", { expected: null, partnerId: dots.id }, "PUT");
      f.plan[f.chief.id] = { turns: ["one", "two", "three"].map(message => ({
        steps: [{ arguments: { bot_ids: [dots.id], message } }], reply: "Assigned " + message,
      })) };
      f.save();
      const start = async (text: string, count: number) => {
        const sendId = randomUUID();
        await f.api(path + "/messages", { threadId: thread, sendId, text });
        await expect.poll(() => local.sends.size, { timeout: 12000 }).toBe(count);
        const [key, op] = [...local.sends].at(-1)!;
        return { key, op, route: path + "/requests/" + sendId };
      };
      const a = await start("One", 1);
      const state = () => f.api(a.route + "?threadId=" + thread);
      await expect.poll(async () => (await state()).phase).toBe("waiting");
      const current = await state();
      await f.api(a.route + "/interrupt", { threadId: thread, messageId: current.messageId, expectedActiveLeafId: current.activeLeafId,
        expectedTurnId: current.activeTurnId, expectedExecutionId: current.executionId });
      local.event({ kind: "reply", text: "late cancelled work", message_id: a.key });
      const b = await start("Two", 2);
      await f.api(path, { visibility: "everyone" }, "PATCH");
      local.event({ kind: "reply", text: "private result", message_id: b.key });
      const messages = () => f.messages(thread) as Promise<any[]>;
      await expect.poll(() => f.nodes().find((n: any) => n.id === b.op.correlation_id)?.reported, { timeout: 7000 }).toBe(true);
      expect((await messages()).some(r => r.text === "private result" || r.text === "late cancelled work")).toBe(false);
      local.authorize(false);
      expect(await f.api("/api/dots/status")).toEqual({ connected: true, authorized: false, subscription: "unknown" });
      local.event({ kind: "reply", text: "unknown owner", message_id: "msg-unmatched" });
      local.event({ kind: "push", text: "after recovery" });
      await expect.poll(local.refusedPolls, { timeout: 14000 }).toBeGreaterThan(0);
      expect((await f.messages(dots.threadId)).some((r: any) => r.text === "after recovery")).toBe(false);
      local.authorize(true);
      const inbox = () => f.messages(dots.threadId) as Promise<any[]>;
      await expect.poll(async () => (await inbox()).some(r => r.text === "after recovery"), { timeout: 15000 }).toBe(true);
      expect((await inbox()).some(r => r.text === "unknown owner")).toBe(false);
      await f.api(path, { visibility: "admins" }, "PATCH");
      const c = await start("Third", 3);
      local.event({ kind: "expired", message_id: c.key });
      await expect.poll(() => f.nodes().find((n: any) => n.id === c.op.correlation_id)?.outcome).toBe("expired");
      const direct = await f.api("/api/bots/" + dots.id + "/messages", { threadId: dots.threadId, text: "Direct wait", sendId: randomUUID() });
      await expect.poll(() => local.sends.size).toBe(4);
      await f.api("/api/bots/" + dots.id + "/interrupt", { threadId: dots.threadId });
      local.event({ kind: "reply", text: "late direct answer", message_id: [...local.sends.keys()].at(-1) });
      await expect.poll(async () => (await inbox()).find(r => r.text === "late direct answer")?.replyToId).toBe(direct.message.id);
    }, {}, local);
  } finally { await local.close(); }
}, 90000);

it("leaves the cursor in place for a hidden inbox and resumes after restarting hidden", async () => {
  const local = await endpoint();
  try {
    await fixture(async f => {
      const dots = (await f.api("/api/bots?messages=0")).bots.find((b: any) => b.modelSelection.instanceId === "dots");
      const path = "/api/bots/" + dots.id;
      local.event({ kind: "push", text: "Before hiding" });
      await expect.poll(local.cursor, { timeout: 8000 }).toBe(1);
      const before = local.ackAttempts();
      const poll = local.pauseNextPoll();
      try {
        await poll.started;
        await f.api(path, { hidden: true }, "PATCH");
        local.event({ kind: "push", text: "While hidden" });
      } finally { poll.release(); }
      await delay(500);
      expect(local.ackAttempts()).toBe(before);
      const exited = once(f.session.child, "exit"); f.session.child.kill("SIGKILL"); await exited;
      await withRestartedHost(f.session.info, async () => {
        local.event({ kind: "push", text: "After restarting hidden" });
        expect(local.cursor()).toBe(1);
        await f.api(path, { hidden: false }, "PATCH");
        await expect.poll(local.cursor, { timeout: 8000 }).toBe(3);
        const arrivals = async () => (await f.messages(dots.threadId)).filter((r: any) => r.dotsEventId).map((r: any) => r.text);
        await expect.poll(arrivals).toEqual(["Before hiding", "While hidden", "After restarting hidden"]);
      });
    }, {}, local);
  } finally { await local.close(); }
}, 45000);

it("releases the single work-partner binding only when its source conversation is deleted", async () => {
  const local = await endpoint();
  try {
    await fixture(async f => {
      const dots = (await f.api("/api/bots?messages=0")).bots.find((b: any) => b.modelSelection.instanceId === "dots");
      const path = "/api/bots/" + f.chief.id, source = f.chief.activeTaskId;
      await f.api(path, { visibility: "admins" }, "PATCH");
      await f.api(path + "/work-partner?threadId=" + source, { expected: null, partnerId: dots.id }, "PUT");
      const { task } = await f.api(path + "/tasks", {});
      await f.api(path + "/tasks/" + task.threadId, {}, "DELETE");
      expect((await f.api(path + "/work-partner?threadId=" + source)).partnerId).toBe(dots.id);
      await f.api(path + "/tasks/" + source, {}, "DELETE");
      const next = await f.api(path + "/work-partner");
      expect(next).toMatchObject({ partnerId: null, dots: { eligible: true, otherThread: false } });
      await f.api("/api/bots/" + f.lead.id, { visibility: "admins" }, "PATCH");
      const rebound = await f.api("/api/bots/" + f.lead.id + "/work-partner", { expected: null, partnerId: dots.id }, "PUT");
      expect(rebound.partnerId).toBe(dots.id);
    }, {}, local);
  } finally { await local.close(); }
}, 30000);
