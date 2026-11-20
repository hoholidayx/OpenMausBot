import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { BOT_MEMORY_SERVER, BOT_MEMORY_TOOLS } from "../shared/bot-memory.ts";
import { fixtureChatReply, fixtureChatSelection, startLoopbackChat } from "./testing/loopback-chat.ts";
import { fixtureMemory } from "./testing/memory-mcp.ts";

it("grants six tools to owner-device private turns and confines records and deletion approvals to the mounted bot", async () => {
  const fixture = await launchVerificationServer();
  const { url, dataDir, logPath } = fixture.info;
  const upstream = fixtureMemory();
  const mem = await upstream.start();
  let action: { name: string; args: Record<string, string | boolean> } | undefined;
  let results: string[] = [];
  const provider = await startLoopbackChat(request => {
    const last = request.messages.at(-1);
    if (last?.role === "tool") results.push(String(last.content));
    if (!action || last?.role === "tool") return fixtureChatReply("Finished fixture turn.");
    return fixtureChatReply("", { name: BOT_MEMORY_SERVER + "_" + action.name, args: action.args });
  });
  const api = async (method: string, path: string, body?: unknown, token?: string, status?: number) => {
    const response = await fetch(url + path, { method, headers: { "content-type": "application/json", origin: url, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json() as any;
    expect(status === undefined ? response.ok : response.status === status, method + " " + path + " " + response.status + " " + (data.error ?? "")).toBe(true);
    return data;
  };
  const device = async (label: string, scopes = ["client", "admin"]) => {
    const open = await api("POST", "/api/auth/pairing", { label, scopes });
    return (await api("POST", "/api/auth/pair", { code: open.code, label })).token as string;
  };
  const evidence: object[] = [];
  const control = (...args: string[]) => runControlOmb([...args, "--url", url]) as Promise<any>;
  const create = async (name: string) => {
    const { bot } = await control("new-bot", "--name", name);
    await api("PATCH", "/api/bots/" + bot.id, { modelSelection: fixtureChatSelection(), toolScope: { allow: ["mcp:maus_memory:*"] }, approvalMode: "full", mcpServers: [] });
    return { id: String(bot.id), thread: String(bot.activeTaskId) };
  };
  const settings = (bot: { id: string }) => "/api/bots/" + bot.id + "/long-term-memory";
  const run = async (bot: { id: string; thread: string }, token?: string, name?: string, args: Record<string, string | boolean> = {},
    onDelete?: (requestId: string) => Promise<void>) => {
    results = [];
    action = name ? { name, args } : undefined;
    const before = provider.requests.length;
    await api("POST", "/api/bots/" + bot.id + "/messages", { threadId: bot.thread, text: `Fixture ${evidence.length}: ${name ?? "ordinary reply"}` }, token, 202);
    const target = ["--bot", bot.id, "--task", bot.thread];
    for (let round = 0; round < 5; round++) {
      const state = await control("wait", ...target, "--timeout", "15");
      if (state.status !== "needs-user") break;
      const rows = (await api("GET", "/api/threads/" + bot.thread + "/messages?limit=100")).messages;
      const card = rows.findLast((row: any) => row.card?.requestId && !row.card.answered)?.card;
      if (!card) continue;
      if (card.tool === "maus_memory_delete" && onDelete) await onDelete(card.requestId);
      else await api("POST", "/api/bots/" + bot.id + "/respond", { threadId: bot.thread, requestId: card.requestId, behavior: "allow" }, token);
    }
    const tools = provider.requests[before]?.tools?.map(tool => tool.function.name).filter(tool => tool.startsWith(BOT_MEMORY_SERVER + "_")) ?? [];
    evidence.push({ name, bot: bot.id, thread: bot.thread, tools, results: [...results] });
    return { tools, result: results.join("\n") };
  };
  try {
    await provider.connect(url);
    const laptop = await device("Laptop"), phone = await device("Phone"), chatOnly = await device("Client", ["client"]);
    const a = await create("A"), b = await create("B");
    const { userId } = await api("GET", settings(a), undefined, laptop);
    const roleA = upstream.role(userId, a.id), roleB = upstream.role(userId, b.id);
    const bind = (role: string) => ({ enabled: true, url: mem.url, token: role });
    await api("PUT", settings(a), bind(roleA), chatOnly, 403);
    await api("PUT", settings(b), bind(roleA), laptop, 422);
    expect(await api("GET", settings(b))).toMatchObject({ configured: false, failed: true });
    expect((await run(b, laptop)).tools).toEqual([]);
    const status = await api("PUT", settings(a), bind(roleA), laptop);
    expect(status).toMatchObject({ enabled: true, configured: true, failed: false });
    expect(JSON.stringify(status)).not.toContain(roleA);
    const file = join(dataDir, "providers", "mem0", "bindings.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const calls = mem.calls.length;
    expect((await run(a, phone)).tools).toHaveLength(6);
    expect((await run(a)).tools).toEqual([]);
    expect((await run(a, chatOnly)).tools).toEqual([]);
    expect(mem.calls).toHaveLength(calls);
    const fact = "Synthetic amber notebook";
    const added = await run(a, laptop, "memory_add", { text: fact });
    expect(added.result).toContain(fact);
    const id = [...upstream.rows.keys()][0]!;
    await api("PATCH", "/api/bots/" + a.id, { name: "Renamed A" });
    const next = (await api("POST", "/api/bots/" + a.id + "/tasks", { title: "Other device" })).task;
    const other = { ...a, thread: next.threadId };
    expect((await run(other, phone, "memory_search", { query: fact })).result).toContain(id);
    expect((await run(other, phone, "memory_get", { memoryId: id })).result).toContain(fact);
    await api("PUT", settings(b), bind(roleB), laptop);
    for (const name of BOT_MEMORY_TOOLS.filter(tool => tool !== "memory_add")) {
      const args = name === "memory_search" ? { query: fact } : name === "memory_list" ? {} : name === "memory_update" ? { memoryId: id, text: "changed" } : { memoryId: id };
      const { result } = await run(b, phone, name, args as Record<string, string>);
      expect(result).not.toContain(fact);
      expect(result).toContain(["memory_search", "memory_list"].includes(name) ? "memories" : "not_found");
    }
    expect(upstream.rows.get(id)?.memory).toBe(fact);
    const deletes = () => mem.calls.filter(call => (call as { name: string }).name === "memory_delete").length;
    const before = deletes();
    await run(other, phone, "memory_delete", { memoryId: id }, async requestId => {
      await api("POST", "/api/bots/" + a.id + "/respond", { threadId: other.thread, requestId, behavior: "allow" }, undefined, 403);
      await api("PUT", settings(a), { enabled: false }, laptop);
    });
    expect(deletes()).toBe(before);
    expect((await run(a, laptop)).tools).toEqual([]);
    await api("PUT", settings(a), { enabled: true }, laptop);
    expect((await run(a, laptop, "memory_get", { memoryId: id })).result).toContain(fact);
    expect((await run(a, phone, "memory_delete", { all: true, confirm: true })).result).toContain("partition");
    expect(deletes()).toBe(before);
    expect((await run(a, laptop, "memory_delete", { memoryId: id })).result).toContain(id);
    expect(upstream.rows.size).toBe(0);
    for (const secret of [roleA, roleB]) {
      expect(JSON.stringify(provider.requests)).not.toContain(secret);
      expect(readFileSync(logPath, "utf8")).not.toContain(secret);
    }
  } finally {
    writeFileSync(logPath + ".bot-memory.json", JSON.stringify(evidence, null, 2), { mode: 0o600 });
    await Promise.all([provider.close(), mem.close(), fixture.close()]);
  }
}, 150_000);
