import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, verificationServerArgs, verificationServerEnvironment } from "../scripts/control-omb.ts";
import type { WireGroup, WireMessage } from "../shared/wire.ts";
import { waitForExit } from "./testing/cleanup.ts";
import { fixtureChatText as textOf, fixtureModel, startLoopbackChat, type ChatFixtureRequest } from "./testing/loopback-chat.ts";

const capabilityKey = "test-context-compaction";

async function setup() {
  let requests: ChatFixtureRequest[] = [];
  let nextTool: { marker: string; match: string; args: object } | undefined;
  const summaries = () => requests.filter(request => !request.stream && textOf(request).includes("Update the summary"));
  const upstream = await startLoopbackChat(request => {
    const text = textOf(request);
    const summary = !request.stream && text.includes("Update the summary");
    const content = summary ? `Result ${summaries().length}` : "Fixture reply";
    const tool = nextTool && text.includes(nextTool.marker)
      ? request.tools?.find(tool => tool.function.name.endsWith(nextTool!.match)) : undefined;
    const tool_calls = tool ? [{
      index: 0, id: "fixture-call", type: "function",
      function: { name: tool.function.name, arguments: JSON.stringify(nextTool!.args) },
    }] : undefined;
    if (tool_calls) nextTool = undefined;
    const choice = tool_calls ? { tool_calls } : { content };
    const finish_reason = tool_calls ? "tool_calls" : "stop";
    const usage = request.messages.at(-1)?.content?.includes("ACTUAL_USAGE") ? { prompt_tokens: 14_900, completion_tokens: 100 } : undefined;
    return { choice, finish_reason, usage };
  });
  requests = upstream.requests;
  const environment = { ...process.env, FAKE_CLAUDE_VERSION: "2.1.270", FAKE_CODEX_TEXT_COMPACTION: "1",
    FAKE_CODEX_MODE: "resume", OMB_TEST_INTERNAL_CAPABILITY_KEY: capabilityKey };
  const app = await launchVerificationServer(
    environment,
    undefined, undefined, undefined, undefined, { scripted: true }, ["codex"],
  ).catch(async error => { await upstream.close(); throw error; });
  const { url, dataDir } = app.info;
  let restarted: ChildProcess | undefined;
  const restart = async (beforeLaunch?: () => void) => {
    await waitForExit(restarted ?? app.child, { signal: "SIGTERM" });
    beforeLaunch?.();
    const env = verificationServerEnvironment(environment, dataDir, Number(new URL(url).port));
    const log = openSync(app.info.logPath, "a", 0o600);
    try {
      restarted = spawn(process.execPath, verificationServerArgs(env), { env, stdio: ["ignore", log, log] });
    } finally { closeSync(log); }
    await expect.poll(async () => {
      try { return (await fetch(url + "/api/health", { signal: AbortSignal.timeout(1_000) })).ok; }
      catch { return false; }
    }, { timeout: 15_000 }).toBe(true);
  };
  async function api<T = unknown>(method: string, path: string, value?: unknown, expected?: number): Promise<T> {
    const response = await fetch(url + path, {
      method, headers: { "content-type": "application/json", origin: url },
      body: value === undefined ? undefined : JSON.stringify(value),
    });
    const result = await response.json() as T;
    if (expected === undefined) expect(response.ok, JSON.stringify(result)).toBe(true);
    else expect(response.status, JSON.stringify(result)).toBe(expected);
    return result;
  }
  async function control(args: string[]) {
    return await runControlOmb(args, { env: { OPENMAUSBOT_URL: url } });
  }
  async function capability(bot: { id: string; threadId: string }) {
    const minted = await fetch(url + "/api/testing/internal-capability", {
      method: "POST", headers: { "content-type": "application/json", "x-openmausbot-test-capability": capabilityKey },
      body: JSON.stringify({ botId: bot.id, threadId: bot.threadId }),
    });
    expect(minted.status).toBe(201);
    return (await minted.json() as { token: string }).token;
  }
  async function bot(name: string, driver = "openaiCompat") {
    const { bot } = await control(["new-bot", "--name", name]) as { bot: { id: string; activeTaskId: string } };
    if (driver !== "claude") {
      await control(["set-model", "--bot", bot.id, "--instance", driver, "--model", driver === "codex" ? "gpt-fake-default" : fixtureModel]);
    }
    return { id: bot.id, threadId: bot.activeTaskId };
  }
  const wait = async (flags: string[]) => {
    expect(await control(["wait", ...flags, "--timeout", "20"])).toMatchObject({ status: "settled" });
  };
  const messages = async (threadId: string) => (await api<{ messages: WireMessage[] }>("GET", `/api/threads/${threadId}/messages?limit=200`)).messages;
  const group = async (id: string) => (await api<{ groups: WireGroup[] }>("GET", "/api/bots?messages=0")).groups.find(room => room.id === id)!;
  const rows = () => {
    const db = new DatabaseSync(join(dataDir, "messages.db"), { readOnly: true });
    try { return db.prepare("SELECT thread_id, bot_id, summary, scope FROM conversation_summaries ORDER BY thread_id, bot_id").all(); }
    finally { db.close(); }
  };
  const close = async () => {
    try {
      if (restarted) await waitForExit(restarted, { signal: "SIGTERM" });
      await app.close();
    }
    finally { await upstream.close(); }
  };
  try {
    await api("PATCH", "/api/config", {
      openaiCompat: upstream.config,
      context: { compactAt: 110_000, keepMessages: 2, idleCompact: false },
    });
    await api("POST", "/api/instances/openaiCompat/refresh-models", {});
    return { api, bot, capability, close, control, dataDir, group, messages, requests, restart, rows, summaries, url, wait,
      tool: (value: NonNullable<typeof nextTool>) => { nextTool = value; } };
  } catch (error) {
    await close();
    throw error;
  }
}

it("uses one recursive compactor for a direct API bot and separate room members while keeping original messages searchable", async () => {
  const f = await setup();
  try {
    const alpha = await f.bot("Alpha");
    const beta = await f.bot("Beta");
    for (const [bot, note] of [[alpha, "MAINTAINER_NOTE"], [beta, "BETA_PRIVATE_NOTE"]] as const) {
      const directory = join(f.dataDir, "bots", bot.id);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "MEMORY.md"), `# Notes\n${note}\n`);
    }
    const { group: room } = await f.api<{ group: WireGroup }>("POST", "/api/groups", {
      name: "Release room", memberIds: [alpha.id, beta.id], setup: { bulletin: "", defaultResponder: { kind: "mentions" } },
    });
    await f.api("PATCH", `/api/groups/${room.id}/setup`, { action: "skip" });
    const sendDirect = async (text: string) => {
      await f.control(["send", "--bot", alpha.id, "--task", alpha.threadId, "--text", text]);
      await f.wait(["--bot", alpha.id, "--task", alpha.threadId]);
    };
    const directCompact = `/api/bots/${alpha.id}/compact`;
    await sendDirect("ORIGINAL_ALPHA use port 9000.");
    expect(textOf(f.requests.find(request => request.stream)!)).toContain("MAINTAINER_NOTE");
    await sendDirect("CORRECTION_BETA use port 9001.");
    expect(await f.api("POST", directCompact, { threadId: alpha.threadId })).toMatchObject({ compacted: true });
    expect(textOf(f.summaries()[0]!)).toContain("ORIGINAL_ALPHA");
    expect(textOf(f.summaries()[0]!)).not.toContain("CORRECTION_BETA");
    expect(f.summaries()[0]!.tools).toBeUndefined();
    expect(await f.api("POST", directCompact, { threadId: alpha.threadId })).toMatchObject({ compacted: false });

    await sendDirect("THIRD_DIRECT confirm the port.");
    expect(textOf(f.requests.findLast(request => request.stream)!)).toContain("Result 1");
    expect(textOf(f.requests.findLast(request => request.stream)!)).toContain("CORRECTION_BETA");
    expect(await f.api("POST", directCompact, { threadId: alpha.threadId })).toMatchObject({ compacted: true });
    expect(textOf(f.summaries()[1]!)).toContain('"previousSummary":"Result 1"');
    expect(textOf(f.summaries()[1]!)).toContain("CORRECTION_BETA");
    expect(textOf(f.summaries()[1]!)).not.toContain("ORIGINAL_ALPHA");
    await sendDirect("FOURTH_DIRECT proceed.");
    expect(await f.api("POST", directCompact, { threadId: alpha.threadId })).toMatchObject({ compacted: true });
    expect(textOf(f.summaries()[2]!)).toContain('"previousSummary":"Result 2"');

    const sendRoom = async (text: string) => {
      await f.control(["send-channel", "--channel", room.id, "--task", room.threadId, "--text", text]);
      await f.wait(["--channel", room.id, "--task", room.threadId]);
    };
    await sendRoom("@Alpha ORIGINAL_ROOM_MARKER");
    const firstRoom = f.requests.findLast(request => request.stream)!;
    expect(textOf(firstRoom).includes("MAINTAINER_NOTE")).toBe(true);
    expect(textOf(firstRoom).includes("BETA_PRIVATE_NOTE")).toBe(false);
    await sendRoom("@Beta ROOM_PEER");
    await sendRoom("@Alpha ROOM_RECENT");
    expect(f.requests.findLast(request => request.stream)!.messages.slice(0, 2)).toEqual([
      firstRoom.messages[0], firstRoom.messages.at(-1),
    ]);
    const memberCompact = `/api/groups/${room.id}/members/${alpha.id}/compact`;
    expect(await f.api("POST", memberCompact, { threadId: room.threadId })).toMatchObject({ compacted: true });
    expect(textOf(f.summaries()[3]!)).toContain("ORIGINAL_ROOM_MARKER");
    await f.restart();
    await sendRoom("@Alpha ROOM_ALPHA_NEXT");
    const packet = f.requests.findLast(request => request.stream)!;
    expect(textOf(packet)).toContain("Result 4");
    expect(packet.messages.at(-1)?.content).toContain("ROOM_ALPHA_NEXT");
    expect(packet.messages.at(-1)?.content).not.toContain("ROOM_RECENT");
    expect(packet.messages.some(message => message.role === "assistant" && message.content === "Fixture reply")).toBe(true);
    await sendRoom("@Beta ROOM_BETA_NEXT");
    expect(textOf(f.requests.findLast(request => request.stream)!)).not.toContain("Result 4");
    expect(f.rows()).toHaveLength(2);
    expect(f.rows()).toEqual(expect.arrayContaining([
      expect.objectContaining({ thread_id: alpha.threadId, bot_id: alpha.id, summary: "Result 3" }),
      expect.objectContaining({ thread_id: room.threadId, bot_id: alpha.id, summary: "Result 4" }),
    ]));
    expect(JSON.stringify(f.rows())).not.toContain("synthetic-fixture-key");

    const messages = await f.messages(alpha.threadId);
    expect(messages.filter(message => message.kind === "compaction")).toHaveLength(3);
    expect(messages.filter(message => message.kind === "compaction").every(message => message.hostCompaction && !message.compaction)).toBe(true);
    expect(JSON.stringify(await f.api("GET", `/api/search?q=ORIGINAL_ALPHA&threadId=${alpha.threadId}`))).toContain("ORIGINAL_ALPHA");
    expect(JSON.stringify(await f.api("GET", `/api/search?q=ORIGINAL_ROOM_MARKER&threadId=${room.threadId}`))).toContain("ORIGINAL_ROOM_MARKER");
    await f.api("POST", `/api/bots/${alpha.id}/start-fresh`, { threadId: alpha.threadId });
    await sendDirect("AFTER_FRESH");
    expect(textOf(f.requests.findLast(request => request.stream)!)).not.toMatch(/Result [123]|FOURTH_DIRECT/);
  } finally { await f.close(); }
}, 120_000);

it("keeps native bots in their department, filters them from rooms, and delegates only the explicit brief", async () => {
  const f = await setup();
  try {
    const apiBot = await f.bot("Coordinator");
    const native = await f.bot("Native worker", "claude");
    await f.api("PATCH", `/api/bots/${native.id}`, { section: "Delivery", chiefOfStaff: true });
    const { group: room } = await f.api<{ group: WireGroup }>("POST", "/api/groups", {
      name: "Delivery room", section: "Delivery", memberIds: [apiBot.id],
    });
    await f.api("PATCH", `/api/groups/${room.id}/setup`, { action: "skip" });
    await f.api("POST", "/api/groups", { name: "Invalid room", memberIds: [native.id] }, 400);
    await f.api("PATCH", `/api/groups/${room.id}`, { memberIds: [apiBot.id, native.id] }, 400);
    await f.restart(() => {
      const file = join(f.dataDir, "groups.json");
      const groups = JSON.parse(readFileSync(file, "utf8")) as WireGroup[];
      const previous = groups.find(group => group.id === room.id)!;
      previous.memberIds.push(native.id);
      previous.defaultResponder = { kind: "member", botId: native.id };
      writeFileSync(file, JSON.stringify(groups));
    });
    expect((await f.group(room.id)).memberIds).toEqual([apiBot.id]);
    expect((await f.group(room.id)).defaultResponder).toEqual({ kind: "member", botId: apiBot.id });
    const authorization = `Bearer ${await f.capability(native)}`;
    const rooms = await fetch(f.url + `/api/internal/rooms?fromBotId=${native.id}&fromThreadId=${native.threadId}`, { headers: { authorization } });
    expect(await rooms.json()).toMatchObject({ rooms: [], managed: [{ id: room.id, name: "Delivery room" }] });
    const updated = await fetch(f.url + "/api/internal/manage-room", {
      method: "POST", headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ roomId: room.id, action: "set_bulletin", bulletin: "DELIVERY_CHECKLIST" }),
    });
    expect(await updated.json()).toMatchObject({ ok: true, memberIds: [apiBot.id] });
    expect((await f.group(room.id)).bulletin).toBe("DELIVERY_CHECKLIST");
    expect(await f.api("POST", `/api/bots/${native.id}/compact`, { threadId: native.threadId }, 409))
      .toMatchObject({ code: "provider_managed_context" });
    const plan = join(f.dataDir, "room-plan.json");
    writeFileSync(plan, JSON.stringify({ [native.id]: { reply: "DELEGATION_RESULT" } }));
    const send = (text: string) => f.control(["send-channel", "--channel", room.id, "--text", text]);
    await send("ROOM_ONLY_PRECEDING_TEXT");
    await f.wait(["--channel", room.id]);
    const workdir = join(f.dataDir, "workspaces", apiBot.id);
    mkdirSync(workdir, { recursive: true });
    const inputFile = join(workdir, "delivery-brief.txt");
    writeFileSync(inputFile, "Fixture content for the delegated work.");
    f.tool({ marker: "DISPATCH_NOW", match: "coordinate_bots", args: {
      group_id: room.id, bot_ids: [native.id], message: "EXPLICIT_DELEGATION_BRIEF", thread: "new", files: [inputFile],
    } });
    await send("DISPATCH_NOW");
    await expect.poll(() => existsSync(`${plan}.evidence.jsonl`) ? readFileSync(`${plan}.evidence.jsonl`, "utf8") : "", { timeout: 20_000 }).toContain("EXPLICIT_DELEGATION_BRIEF");
    const nativeEvidence = readFileSync(`${plan}.evidence.jsonl`, "utf8");
    expect(nativeEvidence).not.toMatch(/ROOM_ONLY_PRECEDING_TEXT|DISPATCH_NOW/);
    expect(nativeEvidence).toContain("delivery-brief.txt");
    await expect.poll(async () => JSON.stringify(await f.messages(room.threadId)), { timeout: 15_000 }).toContain("DELEGATION_RESULT");
    await f.wait(["--channel", room.id]);
    await f.control(["set-model", "--bot", apiBot.id, "--instance", "codex", "--model", "gpt-fake-default"]);
    expect((await f.group(room.id)).memberIds).toEqual([]);
    expect(JSON.stringify(await f.messages(room.threadId))).toContain("ROOM_ONLY_PRECEDING_TEXT");
    const empty = await f.api("POST", `/api/groups/${room.id}/messages`, { threadId: room.threadId, text: "WHO_CAN_REPLY" }, 409);
    expect(empty).toMatchObject({ errorKey: "serverError.room.apiBotRequired" });

    const codex = await f.bot("Codex probe", "codex");
    const sendCodex = async (text: string) => {
      await f.control(["send", "--bot", codex.id, "--task", codex.threadId, "--text", text]);
      await f.wait(["--bot", codex.id, "--task", codex.threadId]);
    };
    await sendCodex("CODEX_NATIVE_COMPACTION");
    expect((await f.messages(codex.threadId)).filter(message => message.kind === "compaction"))
      .toMatchObject([{ engineCompaction: true }]);
    await sendCodex("CODEX_CONTINUED");
    const rpc = readFileSync(join(f.dataDir, "native", `${codex.threadId}.ndjson`), "utf8")
      .trim().split("\n").map(line => JSON.parse(line)).filter(record => record.dir === "out");
    expect(rpc.filter(record => record.msg.method === "thread/start")).toHaveLength(1);
    expect(rpc.filter(record => record.msg.method === "thread/resume")).toHaveLength(1);
    expect(rpc.filter(record => record.msg.method === "turn/start")).toHaveLength(2);
    expect(JSON.stringify(rpc.filter(record => record.msg.method === "turn/start").at(-1))).not.toContain("CODEX_NATIVE_COMPACTION");
  } finally { await f.close(); }
}, 120_000);

it("uses provider occupancy to compact a short request, then estimates longer input when usage is absent", async () => {
  const f = await setup();
  try {
    const bot = await f.bot("Meter");
    const send = async (text: string) => {
      await f.control(["send", "--bot", bot.id, "--task", bot.threadId, "--text", text]);
      await f.wait(["--bot", bot.id, "--task", bot.threadId]);
    };
    await send("BEFORE_USAGE");
    await send("ACTUAL_USAGE");
    await f.api("PATCH", "/api/config", { context: { compactAt: 13_000, keepMessages: 2, idleCompact: false } });
    await send("SHORT_FOLLOWUP");
    expect(f.summaries()).toHaveLength(1);
    expect(textOf(f.requests.findLast(request => request.stream)!)).toContain("Result 1");
    await send("LARGE_FOLLOWUP ".concat("长文本".repeat(2_500)));
    expect(f.summaries()).toHaveLength(2);
    expect(textOf(f.summaries()[1]!)).toContain('"previousSummary":"Result 1"');
    expect(textOf(f.requests.findLast(request => request.stream)!)).toContain("LARGE_FOLLOWUP ".concat("长文本".repeat(2_500)));
  } finally { await f.close(); }
}, 120_000);
