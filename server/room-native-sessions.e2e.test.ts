import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import { runControlOmb } from "../scripts/control-omb.ts";
import { fixtureApi } from "../scripts/testing/preview-fixture.ts";
import { launchRestartableServer } from "./testing/restartable-server.ts";

type NativeCall = { dir: "out" | "in"; msg: { method?: string; params?: { prompt?: unknown; input?: unknown; sessionId?: string; threadId?: string } } };
type BotRef = { id: string; name: string };
const cli = (name: string) => fileURLToPath(new URL(`./testing/${name}.ts`, import.meta.url));

function receiptOf(dataDir: string, threadId: string, botId: string): string | undefined {
  const db = new DatabaseSync(join(dataDir, "messages.db"), { readOnly: true });
  try {
    const row = db.prepare("SELECT session_id FROM room_sessions WHERE thread_id = ? AND bot_id = ?")
      .get(threadId, botId) as { session_id: string } | undefined;
    return row?.session_id;
  } finally { db.close(); }
}

it.each(["opencodeGo", "codex"] as const)("continues independent %s sessions across members and a server restart", async instance => {
  const server = await launchRestartableServer();
  const { dataDir, url } = server;
  const api = fixtureApi(url, { headers: { origin: url } });
  const control = (...args: string[]) => runControlOmb([...args, "--url", url]);
  const hanging = join(dataDir, "hanging-once");
  try {
    await server.stop();
    const path = join(dataDir, "config.json");
    const config = JSON.parse(readFileSync(path, "utf8"));
    config.context = { autoCompact: false, roomSessions: false };
    config.features = { smartSetupChoices: false };
    config.instances[instance] = instance === "codex"
      ? { driver: instance, config: { cli: cli("fake-codex-app-server") },
          environment: { FAKE_CODEX_MODE: "resume", FAKE_CODEX_DISTINCT_SESSIONS: "1" } }
      : { driver: instance, config: { cli: cli("fake-acp-cli") },
          environment: { FAKE_ACP_MODELS: "fixture/context", FAKE_ACP_DISTINCT_SESSIONS: "1",
            FAKE_ACP_HANG_ON: "CRASH_MARKER", FAKE_ACP_HANG_ONCE_FILE: hanging } };
    writeFileSync(path, JSON.stringify(config));
    await server.start();
    const { instances } = await control("models") as { instances: Array<{ instanceId: string; models: { default: string } }> };
    const model = instances.find(item => item.instanceId === instance)!.models.default;
    const create = async (name: string) => {
      const { bot } = await control("new-bot", "--name", name) as { bot: BotRef };
      await control("set-model", "--bot", bot.id, "--instance", instance, "--model", model);
      return bot;
    };
    const a = await create("Editor");
    const b = await create("Tester");
    const { channel } = await control("new-channel", "--name", "Native verification", "--members", `${a.id},${b.id}`) as
      { channel: { id: string; activeTaskId: string } };
    const { activeTaskId: threadId, id: groupId } = channel;
    const native = (targetThread = threadId) => {
      const file = join(dataDir, "native", `${targetThread}.ndjson`);
      return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean)
        .map(line => JSON.parse(line) as NativeCall).filter(line => line.dir === "out") : [];
    };
    const route = `/api/groups/${groupId}/messages`;
    const receipt = (bot: BotRef, targetThread = threadId) => receiptOf(dataDir, targetThread, bot.id);
    const promptMethod = instance === "codex" ? "turn/start" : "session/prompt";
    const resumeMethod = instance === "codex" ? "thread/resume" : "session/load";
    const send = async (bot: BotRef, marker: string, targetThread = threadId) => {
      const begin = native(targetThread).length;
      const response = await api("POST", route, { threadId: targetThread, text: `@${bot.name} ${marker}` });
      expect(await control("wait", "--channel", groupId, "--timeout", "30")).toMatchObject({ status: "settled" });
      const calls = native(targetThread).slice(begin);
      const prompt = calls.findLast(call => call.msg.method === promptMethod)?.msg.params;
      expect(prompt).toBeDefined();
      const sessionId = prompt?.threadId ?? prompt?.sessionId;
      expect(sessionId).toBeTruthy();
      expect(receipt(bot, targetThread)).toBe(sessionId);
      return { sessionId, messageId: response.message.id, text: JSON.stringify(prompt?.prompt ?? prompt?.input), methods: calls.map(call => call.msg.method) };
    };

    const first = await send(a, "ALPHA_NATIVE");
    const second = await send(b, "BETA_NATIVE");
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(second.text).toContain("ALPHA_NATIVE");
    const third = await send(a, "GAMMA_NATIVE");
    expect(third.sessionId).toBe(first.sessionId);
    expect(third.methods).toContain(resumeMethod);
    expect(third.text).toContain("BETA_NATIVE");
    expect(third.text).not.toContain("ALPHA_NATIVE");
    expect(receipt(b)).toBe(second.sessionId);

    await server.stop();
    await server.start();
    const fourth = await send(b, "DELTA_NATIVE");
    expect(fourth.sessionId).toBe(second.sessionId);
    expect(fourth.methods).toContain(resumeMethod);
    expect(fourth.text).toContain("GAMMA_NATIVE");
    expect(fourth.text).not.toMatch(/ALPHA_NATIVE|BETA_NATIVE/);

    if (instance === "opencodeGo") {
      await api("POST", route, { threadId, text: "@Editor CRASH_MARKER" });
      await expect.poll(() => existsSync(hanging), { timeout: 15_000 }).toBe(true);
      expect(receipt(a)).toBeUndefined();
      const health = await api("GET", "/api/health");
      process.kill(health.pid, "SIGKILL");
      await server.stop();
      await server.start();
      const fresh = await send(a, "AFTER_CRASH");
      expect(fresh.sessionId).not.toBe(first.sessionId);
      expect(fresh.text).toContain("CRASH_MARKER");
      expect(receipt(b)).toBe(second.sessionId);
    }

    const beforeRemoval = receipt(b);
    const roomPath = `/api/groups/${groupId}`;
    await api("PATCH", roomPath, { memberIds: [a.id] });
    expect(receipt(b)).toBeUndefined();
    expect(receipt(a)).toBeTruthy();
    await api("PATCH", roomPath, { memberIds: [a.id, b.id] });
    expect((await send(b, "REJOIN_NATIVE")).sessionId).not.toBe(beforeRemoval);

    const parentSession = receipt(a);
    const fork = await api("POST", `${roomPath}/tasks/${threadId}/forks`, { messageId: first.messageId });
    const forkThread = fork.task.threadId as string;
    await api("POST", `${roomPath}/tasks/${forkThread}?messages=0`);
    const branch = await send(a, "FORK_MARKER", forkThread);
    expect(branch.sessionId).not.toBe(parentSession);
    expect(branch.text).toContain("ALPHA_NATIVE");
    expect(branch.text).not.toMatch(/BETA_NATIVE|GAMMA_NATIVE|DELTA_NATIVE|REJOIN_NATIVE/);
    expect(receipt(a)).toBe(parentSession);
    await api("POST", `${roomPath}/tasks/${threadId}?messages=0`);
    const restored = await send(a, "BACK_TO_PARENT");
    expect(restored.sessionId).toBe(parentSession);
    expect(restored.text).not.toContain("FORK_MARKER");

    const search = await api("GET", "/api/search?q=ALPHA_NATIVE");
    expect(search.hits).toContainEqual(expect.objectContaining({ threadId, snippet: expect.stringContaining("ALPHA_NATIVE") }));
  } finally { await server.close(); }
}, 100_000);
