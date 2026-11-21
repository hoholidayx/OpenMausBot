import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { once } from "node:events";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { fixture } from "../testing/direct-coordination-fixture.ts";
import { dotsBridgeFixture, withRestartedDotsHost } from "../testing/dots-bridge.ts";
import { openRuntimeStore } from "../runtime/store.ts";

async function uploadText(url: string, name: string, body: string) {
  const response = await fetch(url + "/api/files?name=" + name, { method: "POST", headers: { origin: url, "content-type": "text/plain" }, body });
  expect(response.status).toBe(201);
  return (await response.json() as { path: string }).path;
}

it("accepts overlapping inbox messages, edits and targeted stops and delivers receipts once across restart", async () => {
  const local = await dotsBridgeFixture(false);
  try {
    await fixture(async f => {
      const dots = (await f.api("/api/bots?messages=0")).bots.find((b: any) => b.modelSelection.instanceId === "dots");
      const threadId = dots.threadId, bot = "/api/bots/" + dots.id;
      const send = (text: string, sendId = randomUUID()) => f.api(bot + "/messages", { threadId, sendId, text });
      const firstKey = randomUUID();
      const [one, repeat] = await Promise.all([send("First request", firstKey), send("First request", firstKey)]);
      expect(repeat.message.id).toBe(one.message.id);
      const two = await send("Second request");
      expect(two).not.toHaveProperty("queued");
      await expect.poll(() => [...local.sends.values()].map(m => m.text)).toEqual(["First request", "Second request"]);
      expect(f.nodes().filter((n: any) => n.botId === dots.id)).toHaveLength(0);
      writeFileSync(join(f.session.info.dataDir, "stall-turns"), "");
      await delay(450);
      const rows = () => f.messages(threadId) as Promise<any[]>;
      expect((await rows()).map(m => m.text)).toEqual(["First request", "Second request"]);
      const firstStatus = bot + "/requests/" + firstKey;
      expect(await f.api(firstStatus + "?threadId=" + threadId)).toMatchObject({ phase: "waiting", messageId: one.message.id, activeTurnId: null });
      await expect(f.api(bot + "/interrupt", { threadId })).rejects.toThrow();
      const [a, b] = [...local.sends.keys()];
      local.event({ kind: "progress", message_id: a, text: "First progress" });
      local.event({ kind: "push", text: "Independent inbox message" });
      local.event({ kind: "reply", message_id: b, text: "Second answer" });
      await expect.poll(async () => (await rows()).find(m => m.text === "Second answer")?.replyToId).toBe(two.message.id);
      const before = await rows();
      expect(before.find(m => m.text === "First progress")?.replyToId).toBe(one.message.id);
      expect(before.find(m => m.text === "Independent inbox message")?.replyToId).toBeUndefined();
      await expect(send("Changed request", firstKey)).rejects.toThrow();
      const edited = await f.api(bot + "/messages/" + one.message.id + "/edit", { threadId, text: "Edited request", sendId: randomUUID() });
      await expect.poll(() => local.sends.size).toBe(3);
      const state = await f.api(firstStatus + "?threadId=" + threadId);
      await f.api(firstStatus + "/interrupt", { threadId, messageId: one.message.id, expectedActiveLeafId: state.activeLeafId,
        expectedTurnId: state.activeTurnId, expectedExecutionId: state.executionId });
      local.authorize(false);
      const offline = await send("Send when connected");
      expect(local.sends.size).toBe(3);
      const exited = once(f.session.child, "exit"); f.session.child.kill("SIGKILL"); await exited;
      local.authorize(true);
      local.event({ kind: "reply", message_id: a, text: "Late first answer" });
      local.event({ kind: "expired", message_id: [...local.sends.keys()][2] });
      await withRestartedDotsHost(f.session.info, async () => {
        await expect.poll(() => local.sends.size, { timeout: 8000 }).toBe(4);
        expect([...local.sends.values()].at(-1)?.correlation_id).toBe("direct-" + offline.message.id);
        await expect.poll(async () => (await rows()).find(m => m.replyToId === edited.message.id)?.text).toBe("expired");
        const history = await rows();
        const late = history.filter(m => m.text === "Late first answer"), expired = history.find(m => m.text === "expired");
        expect(late).toHaveLength(1);
        expect(late[0]).toMatchObject({ replyToId: one.message.id, turnSucceeded: true });
        expect(offline.message.parentId).toBe(edited.message.id);
        expect(expired).toMatchObject({ parentId: offline.message.id, replyToId: edited.message.id, turnSucceeded: false });
        expect(history.some(m => m.tool?.rescue)).toBe(false);
        const finished = await f.api(firstStatus + "?threadId=" + threadId);
        expect(finished.activeLeafId).toBe(expired.id);
        expect(finished.messages.map((m: any) => m.text)).toEqual(["First request", "First progress", "Late first answer"]);
        expect(local.attempts).toHaveLength(4);
      });
    }, { OMB_FIRST_REPLY_NOTICE_MS: "150", OMB_TEST_STALL_CLOCK: "1" }, local);
  } finally { await local.close(); }
}, 60_000);

it("stops an attachment request during upload while the next inbox message still goes through", async () => {
  const local = await dotsBridgeFixture(false);
  try {
    await fixture(async f => {
      const dots = (await f.api("/api/bots?messages=0")).bots.find((b: any) => b.modelSelection.instanceId === "dots");
      const threadId = dots.threadId, bot = "/api/bots/" + dots.id;
      const file = await uploadText(f.session.info.url, "held.txt", "original upload");
      const sendId = randomUUID(), status = bot + "/requests/" + sendId;
      const upload = local.pauseNext("upload");
      try {
        await f.api(bot + "/messages", { threadId, sendId, text: '<attached-file path="' + file + '" name="held.txt" />' });
        await upload.started;
        await f.api(bot + "/messages", { threadId, sendId: randomUUID(), text: "Still accepted" });
        const pending = await f.api(status + "?threadId=" + threadId);
        await f.api(status + "/interrupt", { threadId, messageId: pending.messageId, expectedActiveLeafId: pending.activeLeafId,
          expectedTurnId: pending.activeTurnId, expectedExecutionId: pending.executionId });
        await expect.poll(() => [...local.sends.values()].map(m => m.text)).toEqual(["Still accepted"]);
      } finally { upload.release(); }
      local.event({ kind: "reply", message_id: [...local.sends.keys()][0], text: "Received" });
      await expect.poll(async () => (await f.messages(threadId)).some((m: any) => m.text === "Received")).toBe(true);
      const stopped = await f.api(status + "?threadId=" + threadId);
      expect(stopped.phase).toBe("settled");
      expect(stopped.messages).toHaveLength(1);
      expect(stopped.messages[0].requestCancelled).toBe(true);
    }, {}, local);
  } finally { await local.close(); }
}, 35_000);

it("adopts an old running direct turn and restores authorized queued messages individually", async () => {
  const local = await dotsBridgeFixture(false);
  try {
    await fixture(async f => {
      const dots = (await f.api("/api/bots?messages=0")).bots.find((b: any) => b.modelSelection.instanceId === "dots");
      const threadId = dots.threadId, info = f.session.info, sendId = randomUUID();
      const sent = await f.api("/api/bots/" + dots.id + "/messages", { threadId, sendId, text: "In flight before upgrade" });
      await expect.poll(() => local.sends.size).toBe(1);
      const op = [...local.sends.values()][0]!.correlation_id, rootId = randomUUID();
      const exit = once(f.session.child, "exit"); f.session.child.kill("SIGKILL"); await exit;
      const runtime = openRuntimeStore(join(info.dataDir, "runtime.db")), at = Date.now();
      try {
        runtime.insert({ id: rootId, rootId, depth: 0, origin: { kind: "person", source: "chat" }, requester: { kind: "person", threadId },
          assignee: { botId: dots.id, destination: { kind: "standing_thread", threadId } }, mode: "work", reply: "resume",
          brief: "In flight before upgrade", status: "running", level: "ask", levelSource: "own", executions: 1, restarts: 0,
          createdAt: at, startedAt: at, lastActivityAt: at, result: "", rework: false, version: 1 }, { kind: "started", at });
      } finally { runtime.close(); }
      const inbox = new DatabaseSync(join(info.dataDir, "providers", "dots", "inbox.sqlite"));
      const chats = new DatabaseSync(join(info.dataDir, "messages.db"));
      try {
        inbox.prepare("UPDATE jobs SET root=?,input=json_set(input,'$.rootId',?) WHERE id=?").run(rootId, rootId, op);
        const put = (text: string, status: string, permitted = true, key: string = randomUUID()) => {
          if (permitted) inbox.prepare("INSERT OR IGNORE INTO grants(thread,send,digest) VALUES (?,?,?)")
            .run(threadId, key, createHash("sha256").update(text).digest("hex"));
          chats.prepare("INSERT INTO chat_followups(id,kind,owner_id,thread_id,send_id,status,payload) VALUES (?,'bot',?,?,?,?,?)")
            .run(randomUUID(), dots.id, threadId, key, status, JSON.stringify({ text, sendId: key }));
        };
        put("In flight before upgrade", "dispatching", true, sendId);
        put("First queued", "pending");
        put("x".repeat(16001), "pending");
        put("Second queued", "dispatching");
        put("Never granted", "pending", false);
        put("Previously cancelled", "cancelled");
      } finally { chats.close(); inbox.close(); }
      await withRestartedDotsHost(info, async () => {
        const rows = () => f.messages(threadId) as Promise<any[]>;
        await expect.poll(() => [...local.sends.values()].map(m => m.text)).toEqual(["In flight before upgrade", "First queued", "Second queued"]);
        expect(f.eventsOf(rootId)).toContain("awaiting_receipt");
        const history = await rows();
        expect(history.filter(m => m.sendId === sendId)).toHaveLength(1);
        const invalid = history.find(m => m.text?.length === 16001);
        expect(invalid).toBeDefined();
        expect(history.find(m => m.text?.includes("16,000 characters"))).toMatchObject({ replyToId: invalid.id });
        for (const request of [...local.sends.values()].reverse()) {
          local.event({ kind: "reply", correlation_id: request.correlation_id, text: "Receipt for " + request.text });
        }
        await expect.poll(() => f.nodes().find((n: any) => n.id === rootId)).toMatchObject({ status: "completed", executions: 1 });
        const replies = (await rows()).filter(m => m.text?.startsWith("Receipt for "));
        expect(replies.map(m => m.replyToId)).toEqual(["Second queued", "First queued", sent.message.text].map(s => history.find(m => m.text === s).id));
        expect(local.attempts).toHaveLength(3);
      });
    }, {}, local);
  } finally { await local.close(); }
}, 45_000);

it("routes interleaved private partner work, unsolicited push and original files across a host restart", async () => {
  const local = await dotsBridgeFixture();
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
      const upload = (name: string, body: string) => uploadText(f.session.info.url, name, body);
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
      await withRestartedDotsHost(info, async () => {
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
  const local = await dotsBridgeFixture();
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

it("stops only the selected delegation while earlier work and the direct inbox still receive replies", async () => {
  const local = await dotsBridgeFixture(false);
  try {
    await fixture(async f => {
      const dots = (await f.api("/api/bots?messages=0")).bots.find((b: any) => b.modelSelection.instanceId === "dots");
      const main = "/api/bots/" + f.chief.id, threadId = f.chief.activeTaskId;
      await f.api(main, { visibility: "admins" }, "PATCH");
      await f.api(main + "/work-partner", { expected: null, partnerId: dots.id }, "PUT");
      f.plan[f.chief.id] = { turns: ["alpha", "bravo"].map(message => ({
        steps: [{ arguments: { bot_ids: [dots.id], message } }], reply: "Assigned " + message,
      })) };
      f.save();
      const first = await f.api(main + "/messages", { threadId, sendId: randomUUID(), text: "First assignment" });
      const rows = () => f.messages(threadId) as Promise<any[]>;
      await expect.poll(async () => (await rows()).some(m => m.text === "Assigned alpha")).toBe(true);
      const secondId = randomUUID();
      await f.api(main + "/messages", { threadId, sendId: secondId, text: "Second assignment" });
      const inbox = await f.api("/api/bots/" + dots.id + "/messages", { threadId: dots.threadId, sendId: randomUUID(), text: "Independent question" });
      await expect.poll(() => local.sends.size).toBe(3);
      const secondState = main + "/requests/" + secondId;
      await expect.poll(async () => (await f.api(secondState + "?threadId=" + threadId)).phase).toBe("waiting");
      const status = await f.api(secondState + "?threadId=" + threadId);
      await f.api(secondState + "/interrupt", { threadId, messageId: status.messageId, expectedActiveLeafId: status.activeLeafId,
        expectedTurnId: status.activeTurnId, expectedExecutionId: status.executionId });
      const receipt = (request: string, text: string) => {
        const submitted = [...local.sends.values()].find(m => m.text === request)!;
        local.event({ kind: "reply", correlation_id: submitted.correlation_id, text });
      };
      receipt("bravo", "Stopped work");
      receipt("Independent question", "Inbox answer");
      receipt("alpha", "First still delivered");
      await expect.poll(async () => (await rows()).find(m => m.text === "First still delivered")?.replyToId).toBe(first.message.id);
      expect((await rows()).some(m => m.text === "Stopped work" || m.text === "Inbox answer")).toBe(false);
      expect((await f.messages(dots.threadId)).filter((m: any) => m.dotsEventId).map((m: any) => [m.text, m.replyToId]))
        .toEqual([["Inbox answer", inbox.message.id]]);
      expect(f.evidence().filter((e: any) => e.botId === f.chief.id)).toHaveLength(2);
    }, {}, local);
  } finally { await local.close(); }
}, 50_000);

it("preserves both parked delegations when a thread-wide stop after restart has no request owner", async () => {
  const local = await dotsBridgeFixture(false);
  try {
    await fixture(async f => {
      const dots = (await f.api("/api/bots?messages=0")).bots.find((b: any) => b.modelSelection.instanceId === "dots");
      const main = "/api/bots/" + f.chief.id, threadId = f.chief.activeTaskId;
      await f.api(main, { visibility: "admins" }, "PATCH");
      await f.api(main + "/work-partner", { expected: null, partnerId: dots.id }, "PUT");
      f.plan[f.chief.id] = { turns: ["east", "west"].map(message => ({
        steps: [{ arguments: { bot_ids: [dots.id], message } }], reply: "Dispatched " + message,
      })) };
      f.save();
      const rows = () => f.messages(threadId) as Promise<any[]>;
      for (const text of ["east", "west"]) {
        await f.api(main + "/messages", { threadId, sendId: randomUUID(), text });
        await expect.poll(async () => (await rows()).some(m => m.text === "Dispatched " + text)).toBe(true);
      }
      await expect.poll(() => local.sends.size).toBe(2);
      const exited = once(f.session.child, "exit"); f.session.child.kill("SIGKILL"); await exited;
      await withRestartedDotsHost(f.session.info, async () => {
        await expect(f.api(main + "/interrupt", { threadId })).rejects.toThrow(/Choose the Dots request/);
        for (const [key, request] of local.sends) local.event({ kind: "reply", message_id: key, text: "Done " + request.text });
        await expect.poll(async () => (await rows()).filter(m => m.partnerResultId).map(m => m.text)).toEqual(["Done east", "Done west"]);
        expect(local.attempts).toHaveLength(2);
      });
    }, {}, local);
  } finally { await local.close(); }
}, 50_000);

it("leaves the cursor in place for a hidden inbox and resumes after restarting hidden", async () => {
  const local = await dotsBridgeFixture();
  try {
    await fixture(async f => {
      const dots = (await f.api("/api/bots?messages=0")).bots.find((b: any) => b.modelSelection.instanceId === "dots");
      const path = "/api/bots/" + dots.id;
      local.event({ kind: "push", text: "Before hiding" });
      await expect.poll(local.cursor, { timeout: 8000 }).toBe(1);
      const before = local.ackAttempts();
      const poll = local.pauseNext("poll");
      try {
        await poll.started;
        await f.api(path, { hidden: true }, "PATCH");
        local.event({ kind: "push", text: "While hidden" });
      } finally { poll.release(); }
      await delay(500);
      expect(local.ackAttempts()).toBe(before);
      const exited = once(f.session.child, "exit"); f.session.child.kill("SIGKILL"); await exited;
      await withRestartedDotsHost(f.session.info, async () => {
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
  const local = await dotsBridgeFixture();
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
