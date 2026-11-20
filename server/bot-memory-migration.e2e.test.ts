import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, verificationServerArgs, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { migrateSharedMemory } from "./bot-memory-migration.ts";
import { waitForExit } from "./testing/cleanup.ts";
import { fixtureChatReply, fixtureChatSelection, startLoopbackChat } from "./testing/loopback-chat.ts";
import { fixtureMemory } from "./testing/memory-mcp.ts";
import { excludedWorkspaceAuthPath } from "./workspace-backup-policy.ts";

it("switches only the verified workspace role and preserves per-bot exclusions across upgrade, restore and repeated starts", async () => {
  const fixture = await launchVerificationServer();
  const { dataDir, url, logPath } = fixture.info;
  const upstream = fixtureMemory(), mem = await upstream.start();
  let offline = false;
  const provider = await startLoopbackChat(request => {
    const list = request.tools?.find(tool => tool.function.name === "maus_memory_memory_list");
    if (offline && list && request.messages.at(-1)?.role === "user") return fixtureChatReply("", { name: list.function.name, args: {} });
    return fixtureChatReply("Fixture is still available.");
  });
  let child = fixture.child;
  const stop = () => waitForExit(child, { signal: "SIGTERM" });
  const start = async () => {
    const env = verificationServerEnvironment({}, dataDir, Number(new URL(url).port));
    const log = openSync(logPath, "a", 0o600);
    try { child = spawn(process.execPath, verificationServerArgs(env), { env, stdio: ["ignore", log, log] }); }
    finally { closeSync(log); }
    await expect.poll(async () => {
      try { return (await fetch(url + "/api/health")).ok; } catch { return false; }
    }, { timeout: 15_000 }).toBe(true);
  };
  const api = async (method: string, path: string, body?: unknown, token?: string, expected?: number) => {
    const response = await fetch(url + path, { method, headers: { "content-type": "application/json", origin: url, ...(token ? { authorization: "Bearer " + token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const value = await response.json() as any;
    expect(expected === undefined ? response.ok : response.status === expected, method + " " + path + " " + response.status + " " + (value.error ?? "")).toBe(true);
    return value;
  };
  const cli = (...args: string[]) => runControlOmb([...args, "--url", url]) as Promise<any>;
  const create = async (name: string, exclude = false) => {
    const { bot } = await cli("new-bot", "--name", name);
    await api("PATCH", "/api/bots/" + bot.id, { modelSelection: fixtureChatSelection(), approvalMode: "full",
      toolScope: { allow: ["mcp:mem0:*", "mcp:maus_memory:*"] }, ...(exclude ? { mcpServers: [] } : {}) });
    return { id: String(bot.id), thread: String(bot.activeTaskId) };
  };
  type Bot = Awaited<ReturnType<typeof create>>;
  const settings = (bot: Bot) => "/api/bots/" + bot.id + "/long-term-memory";
  const evidence: object[] = [];
  let owner: string;
  const offered = async (bot: Bot) => {
    const before = provider.requests.length;
    await api("POST", "/api/bots/" + bot.id + "/messages", { threadId: bot.thread, text: "Fixture check " + before }, owner);
    let state = await cli("wait", "--bot", bot.id, "--task", bot.thread, "--timeout", "15");
    if (state.status === "needs-user") {
      const rows = (await api("GET", "/api/threads/" + bot.thread + "/messages?limit=100")).messages;
      const card = rows.findLast((row: any) => row.card?.requestId && !row.card.answered).card;
      await api("POST", "/api/bots/" + bot.id + "/respond", { threadId: bot.thread, requestId: card.requestId, behavior: "allow" }, owner);
      state = await cli("wait", "--bot", bot.id, "--task", bot.thread, "--timeout", "15");
    }
    const actual = provider.requests[before]?.tools?.map(tool => tool.function.name).filter(name => /^(mem0_|maus_memory_)/.test(name)) ?? [];
    evidence.push({ bot: bot.id, tools: actual, state: state.status });
    return actual;
  };
  let memClosed = false;
  try {
    await provider.connect(url);
    owner = (await api("POST", "/api/auth/pair", { code: (await api("POST", "/api/auth/pairing", { scopes: ["client", "admin"] })).code })).token;
    const a = await create("Inherited"), pebble = await create("Pebble", true);
    const { userId } = await api("GET", settings(a));
    const envId = userId.slice(5);
    const old = upstream.role(userId, "workspace"), token = upstream.role(userId, a.id);
    const marker = randomUUID();
    upstream.rows.set(marker, { userId, agentId: "workspace", id: marker, memory: "Existing shared fixture record" });
    const raw = { name: "mem0", type: "http", url: mem.url, headers: { Authorization: "Bearer " + old }, enabled: true };
    await api("POST", "/api/mcp/servers", raw);
    await api("PATCH", "/api/mcp/servers/mem0", { enabled: true });
    expect(await offered(a)).toHaveLength(6);
    expect(await offered(pebble)).toEqual([]);
    await api("PUT", settings(a), { enabled: true, url: mem.url, token }, owner, 409);
    const migrate = (action: "inspect" | "disable" | "restore") => migrateSharedMemory(dataDir, mem.url, action);
    expect((await migrate("inspect")).state).toBe("verified");
    await expect(migrate("disable")).rejects.toThrow();
    await stop();
    expect((await migrateSharedMemory(dataDir, mem.url + "/other", "disable")).state).toBe("unrelated");
    const file = join(dataDir, "config.json"), original = readFileSync(file, "utf8");
    const wrong = JSON.parse(original);
    wrong.mcpServers.mem0.headers.Authorization = "Bearer " + token;
    writeFileSync(file, JSON.stringify(wrong));
    await expect(migrate("disable")).rejects.toThrow("verify");
    expect(JSON.parse(readFileSync(file, "utf8")).mcpServers.mem0.enabled).toBe(true);
    writeFileSync(file, original);
    const migrated = await migrate("disable");
    expect(migrated).toMatchObject({ state: "disabled", bots: expect.arrayContaining([{ id: pebble.id, name: "Pebble", mcpServers: [] }]) });
    const backupFile = join(dataDir, "providers/mem0/legacy-workspace.json");
    const backup = readFileSync(backupFile, "utf8");
    expect(statSync(backupFile).mode & 0o777).toBe(0o600);
    expect((await migrate("disable")).state).toBe("disabled");
    expect(readFileSync(backupFile, "utf8")).toBe(backup);
    await start();
    expect(await offered(a)).toEqual([]);
    expect(await offered(pebble)).toEqual([]);
    await api("PUT", settings(a), { enabled: true, url: mem.url, token }, owner);
    expect(await offered(a)).toContain("maus_memory_memory_get");
    await api("PATCH", "/api/mcp/servers/mem0", { enabled: true }, undefined, 409);
    await stop();
    await expect(migrate("restore")).rejects.toThrow("Turn off");
    await start();
    expect(await api("GET", settings(a))).toMatchObject({ configured: true, enabled: true });
    expect(await offered(a)).toContain("maus_memory_memory_get");
    await api("PUT", settings(a), { enabled: false }, owner);
    await stop();
    expect((await migrate("restore")).state).toBe("restored");
    expect((await migrate("restore")).state).toBe("restored");
    const idFile = join(dataDir, "environment-id");
    const bindings = join(dataDir, "providers/mem0", envId, "bindings.json");
    expect(excludedWorkspaceAuthPath("providers/mem0/" + envId + "/bindings.json")).toBe(true);
    expect(excludedWorkspaceAuthPath("providers/mem0/legacy-workspace.json")).toBe(true);
    await start();
    expect(await offered(a)).toContain("mem0_memory_get");
    expect(await offered(pebble)).toEqual([]);
    expect(upstream.rows.get(marker)?.memory).toBe("Existing shared fixture record");
    await stop();
    await migrate("disable");
    writeFileSync(idFile, randomUUID() + "\n");
    await start();
    expect(await api("GET", settings(a))).toMatchObject({ enabled: false, configured: false });
    await stop();
    writeFileSync(idFile, envId + "\n");
    renameSync(bindings, bindings + ".held");
    await start();
    expect(await api("GET", settings(a))).toMatchObject({ enabled: false, configured: false });
    await stop();
    renameSync(bindings + ".held", bindings);
    await start();
    await api("PUT", settings(a), { enabled: true });
    owner = (await api("POST", "/api/auth/pair", { code: (await api("POST", "/api/auth/pairing", { scopes: ["client", "admin"] })).code })).token;
    await mem.close();
    memClosed = true;
    offline = true;
    await offered(a);
    expect(await api("GET", settings(a))).toMatchObject({ configured: true, enabled: true, failed: true });
    offline = false;
    await offered(a);
    const transcript = await cli("messages", "--bot", a.id, "--task", a.thread, "--limit", "10");
    expect(JSON.stringify(transcript)).toContain("Fixture is still available.");
    expect(upstream.rows.size).toBe(1);
  } finally {
    writeFileSync(logPath + ".memory-migration.json", JSON.stringify(evidence, null, 2), { mode: 0o600 });
    await stop();
    await Promise.all([provider.close(), ...(memClosed ? [] : [mem.close()]), fixture.close()]);
  }
}, 150_000);
