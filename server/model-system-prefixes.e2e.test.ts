import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BotModelPrefixSetting } from "../shared/bot-prompts.ts";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const MODEL = "fixture/primary";
const FAST = "fixture/primary-mini";
const ASK = "Ask a fixture question.";
const PATH = "/api/model-system-prefixes";

interface ChatRequest {
  model: string;
  messages: Array<{ role: string; content: string | null }>;
}

it("sends the selected API model's current prefix, including in rooms and after a restart", async () => {
  const requests: ChatRequest[] = [];
  const upstream = createServer(async (req, res) => {
    if (req.url?.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: MODEL }, { id: FAST }] }));
      return;
    }
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw) as ChatRequest;
    requests.push(body);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const last = body.messages.at(-1);
    if (last?.role === "user" && last.content?.endsWith(ASK)) {
      const tool = { index: 0, id: "fixture-ask", type: "function", function: {
        name: "ask_user", arguments: JSON.stringify({ questions: [{ question: "Proceed with the fixture?" }] }),
      } };
      const chunk = { choices: [{ delta: { tool_calls: [tool] }, finish_reason: "tool_calls" }] };
      res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
      return;
    }
    res.end('data: {"choices":[{"delta":{"content":"Fixture answer."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const closeUpstream = async () => {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  };
  const fixture = await launchVerificationServer().catch(async (error) => {
    await closeUpstream();
    throw error;
  });
  const evidence: unknown[] = [];
  const control = async (args: string[]) => {
    const result = await runControlOmb([...args, "--url", fixture.info.url]) as any;
    evidence.push({ command: args, result });
    return result;
  };
  const api = async (method: string, path: string, data?: unknown, status?: number) => {
    const res = await fetch(fixture.info.url + path, {
      method,
      headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const body = await res.json() as any;
    expect(status === undefined ? res.ok : res.status === status, `${method} ${path}: ${res.status} ${body.error ?? ""}`).toBe(true);
    return body;
  };
  const prefixPath = (instanceId: string, model = MODEL) => PATH + "?" + new URLSearchParams({ instanceId, model });
  const save = (instanceId: string, text: string, model?: string) => api("PUT", prefixPath(instanceId, model), { text });
  const editor = (bot: string, thread?: string) => `/api/bots/${bot}/system-prompt?editor=1${thread ? "&threadId=" + thread : ""}`;
  const edit = (path: string, setting: BotModelPrefixSetting, value: string | null, status = 200) => {
    const { override: expected, ...binding } = setting;
    return api("PUT", path, { ...binding, expected, value }, status);
  };
  const makeBot = async (instance: string, name: string) => {
    const { bot } = await control(["new-bot", "--name", name]);
    expect((await api("GET", editor(bot.id))).modelPrefix).toBeNull();
    await control(["set-model", "--bot", bot.id, "--instance", instance, "--model", MODEL]);
    return { id: bot.id as string, threadId: bot.activeTaskId as string, target: ["--bot", bot.id, "--task", bot.activeTaskId] };
  };
  const direct = async (target: string[], message: string) => {
    expect((await control(["send", ...target, "--text", message])).success).toBe(true);
    expect((await control(["wait", ...target, "--timeout", "20"])).status).toBe("settled");
    await control(["messages", ...target, "--limit", "20"]);
    return requests.filter((request) => request.messages.at(-1)?.content?.endsWith(message));
  };
  const system = (call: ChatRequest) => call.messages.find((message) => message.role === "system")?.content;
  let restarted: ChildProcess | undefined;

  try {
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("Fixture provider did not bind TCP.");
    const local = `http://127.0.0.1:${address.port}`;
    await api("PATCH", "/api/config", {
      openaiCompat: { key: "synthetic-prefix-fixture", url: local + "/one/v1", model: MODEL },
      groq: { key: "synthetic-prefix-fixture", url: local + "/two/v1", model: MODEL },
    });
    await api("POST", "/api/instances/groq/refresh-models", {});
    expect((await api("GET", PATH)).instances).toEqual(expect.arrayContaining(["openaiCompat", "groq"]));
    expect((await api("GET", PATH)).instances).not.toContain("claude");
    await save("openaiCompat", "Fixture model prefix A.");
    await save("groq", "Fixture model prefix on connection two.");
    const firstBot = await makeBot("openaiCompat", "Primary prefix fixture");
    const secondBot = await makeBot("groq", "Room prefix fixture");

    expect((await api("GET", `/api/bots/${firstBot.id}/system-prompt`)).sections[0]).toMatchObject({
      id: "model-system-prefix", text: "Fixture model prefix A.\n\n",
    });
    const [first] = await direct(firstBot.target, "First fixture question.");
    expect(system(first!)).toMatch(/^Fixture model prefix A\.\n\nYou are/);
    await save("openaiCompat", "Fixture model prefix B.");
    const [second] = await direct(firstBot.target, "Second fixture question.");
    expect(system(second!)).toMatch(/^Fixture model prefix B\.\n\nYou are/);
    expect(JSON.stringify(second)).not.toContain("Fixture model prefix A.");
    expect(second!.messages.some((message) => message.role === "user" && message.content?.endsWith("First fixture question."))).toBe(true);
    await save("openaiCompat", "  ");
    const [third] = await direct(firstBot.target, "Third fixture question.");
    expect(system(third!)).toMatch(/^You are/);
    expect(JSON.stringify(third)).not.toContain("Fixture model prefix");

    await save("openaiCompat", "Fixture prefix before the tool.");
    const beforeToolTurn = requests.length;
    expect((await control(["send", ...firstBot.target, "--text", ASK])).success).toBe(true);
    const waitForToolTurn = () => control(["wait", ...firstBot.target, "--timeout", "20"]);
    expect((await waitForToolTurn()).status).toBe("needs-user");
    const { bots } = await api("GET", "/api/bots");
    const current = bots.find((bot: { id: string }) => bot.id === firstBot.id);
    const card = current.messages.find((message: { card?: { requestType: string; answered?: boolean } }) =>
      message.card?.requestType === "question" && !message.card.answered)?.card;
    expect(card?.requestId).toBeTruthy();
    await save("openaiCompat", "Fixture prefix after the tool.");
    await api("POST", `/api/threads/${firstBot.threadId}/respond`, {
      requestId: card.requestId, behavior: "answer", message: "Proceed.",
    });
    expect((await waitForToolTurn()).status).toBe("settled");
    const toolTurn = requests.slice(beforeToolTurn);
    expect(toolTurn).toHaveLength(2);
    expect(toolTurn[1]!.messages.at(-1)?.role).toBe("tool");
    for (const call of toolTurn) expect(system(call)).toMatch(/^Fixture prefix before the tool\.\n\nYou are/);
    const [afterTool] = await direct(firstBot.target, "Follow up after the tool.");
    expect(system(afterTool!)).toMatch(/^Fixture prefix after the tool\.\n\nYou are/);
    await save("openaiCompat", "");

    const roomEditor = editor(secondBot.id);
    const inherited = (await api("GET", roomEditor)).modelPrefix;
    expect(inherited).toMatchObject({ instanceId: "groq", model: MODEL, override: null });
    const custom = (await edit(roomEditor, inherited, "Room bot only.")).modelPrefix;
    await edit(roomEditor, inherited, "Stale fixture.", 409);
    await edit(roomEditor, custom, "汉".repeat(8001), 400);
    const { group } = await api("POST", "/api/groups", {
      name: "Prefix test room", memberIds: [secondBot.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: secondBot.id } },
    });
    await control(["send-channel", "--channel", group.id, "--text", "Greet this room."]);
    expect((await control(["wait", "--channel", group.id, "--timeout", "20"])).status).toBe("settled");
    await control(["messages", "--channel", group.id, "--limit", "10"]);
    expect(system(requests.at(-1)!)).toMatch(/^Room bot only\.\n\nYou are/);
    expect(system(requests.at(-1)!)).not.toContain(inherited.defaultText);

    const legacyBot = await makeBot("groq", "Legacy prefix fixture");
    const legacyEditor = editor(legacyBot.id);
    expect((await api("GET", legacyEditor)).modelPrefix).toEqual(inherited);
    const [otherBot] = await direct(legacyBot.target, "Check the shared default.");
    expect(system(otherBot!)).toMatch(/^Fixture model prefix on connection two\.\n\nYou are/);
    const disabled = await edit(legacyEditor, inherited, "");
    expect(disabled.sections.some((s: { id: string }) => s.id === "model-system-prefix")).toBe(false);
    const [off] = await direct(legacyBot.target, "Check the disabled prefix.");
    expect(system(off!)).toMatch(/^You are/);
    await save("groq", "Updated shared default.");
    await edit(legacyEditor, disabled.modelPrefix, null, 409);
    const restored = await edit(legacyEditor, (await api("GET", legacyEditor)).modelPrefix, null);
    expect(restored.sections[0].text).toBe("Updated shared default.\n\n");
    expect(restored.modelPrefix.override).toBeNull();
    await save("groq", inherited.defaultText);
    await edit(legacyEditor, inherited, "Personal prefix.");
    const threadEditor = editor(secondBot.id, secondBot.threadId);
    const switchThread = (instance: string, model = MODEL) =>
      control(["set-model", ...secondBot.target, "--instance", instance, "--model", model]);
    await switchThread("openaiCompat");
    expect((await api("GET", threadEditor)).modelPrefix.override).toBeNull();
    await edit(threadEditor, custom, "Stale connection.", 409);
    const alternate = await edit(threadEditor, (await api("GET", threadEditor)).modelPrefix, "Pinned connection only.");
    const [pinned] = await direct(secondBot.target, "Check pinned connection.");
    expect(system(pinned!)).toMatch(/^Pinned connection only\.\n\nYou are/);
    expect((await api("GET", roomEditor)).modelPrefix).toEqual(custom);
    await switchThread("groq", FAST);
    expect((await api("GET", threadEditor)).modelPrefix.override).toBeNull();
    await edit(threadEditor, (await api("GET", threadEditor)).modelPrefix, "");
    await switchThread("groq");
    expect((await api("GET", threadEditor)).modelPrefix).toEqual(custom);
    await switchThread("openaiCompat");
    expect((await api("GET", threadEditor)).modelPrefix).toEqual(alternate.modelPrefix);
    expect((await api("GET", "/api/bots")).bots.some((bot: object) => "modelPrefixOverrides" in bot)).toBe(false);

    const { url, dataDir, logPath } = fixture.info;
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const botsFile = join(dataDir, "bots.json");
    const saved = JSON.parse(readFileSync(botsFile, "utf8")) as Array<{ id: string; replyStyle?: string }>;
    saved.find((bot) => bot.id === legacyBot.id)!.replyStyle = "conversational";
    writeFileSync(botsFile, JSON.stringify(saved));
    const log = openSync(logPath, "a", 0o600);
    try {
      restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: verificationServerEnvironment({}, dataDir, Number(new URL(url).port)),
        stdio: ["ignore", log, log],
      });
    } finally {
      closeSync(log);
    }
    await expect.poll(async () => {
      try { return (await fetch(url + "/api/health", { signal: AbortSignal.timeout(1_000) })).ok; }
      catch { return false; }
    }, { timeout: hostTimeout(20_000) }).toBe(true);
    expect(await api("GET", prefixPath("groq"))).toEqual({ text: "Fixture model prefix on connection two." });
    expect(await api("GET", prefixPath("openaiCompat"))).toEqual({ text: "" });
    expect((await api("GET", roomEditor)).modelPrefix).toEqual(custom);
    expect((await api("GET", threadEditor)).modelPrefix).toEqual(alternate.modelPrefix);
    await switchThread("groq", FAST);
    expect((await api("GET", threadEditor)).modelPrefix.override).toBe("");
    const greeting = await direct(legacyBot.target, "Hello there.");
    expect(greeting.map((call) => call.model)).toEqual([MODEL]);
    expect(system(greeting[0]!)).toMatch(/^Personal prefix\.\n\nYou are/);
    expect(system(greeting[0]!)).not.toContain("Reply style: conversational");
    const pinnedGreeting = await direct(secondBot.target, "Hello on this thread.");
    expect(pinnedGreeting.map((call) => call.model)).toEqual([FAST]);
  } finally {
    const evidencePath = join(dirname(fixture.info.logPath), `model-system-prefixes-${fixture.info.pid}.json`);
    writeFileSync(evidencePath, JSON.stringify({
      ...fixture.info, evidence,
      requests: requests.map((call) => ({ model: call.model, systemFirstLine: system(call)?.split("\n")[0] })),
    }, null, 2));
    console.info(JSON.stringify({ evidencePath }));
    await waitForExit(restarted, { signal: "SIGTERM" });
    await fixture.close();
    await closeUpstream();
  }
}, hostTimeout(120_000));
