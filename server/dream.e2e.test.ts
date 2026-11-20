import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { runControlOmb } from "../scripts/control-omb.ts";
import { MEMORY_CONNECTION_PATH } from "../shared/bot-memory.ts";
import type { CoreMemoryView } from "../shared/core-memory.ts";
import { launchRestartableServer } from "./testing/restartable-server.ts";
import { fixtureMemory } from "./testing/memory-mcp.ts";
import { fixtureChatReply, fixtureChatSelection, startLoopbackChat } from "./testing/loopback-chat.ts";

it("resumes an interrupted Dream, keeps chats and Mem0 separate, and publishes exact-capacity edits", async () => {
  vi.stubEnv("OMB_TEST_CORE_MEMORY", "1");
  const fixture = await launchRestartableServer();
  const { url, dataDir } = fixture;
  const upstream = fixtureMemory();
  const mem = await upstream.start();
  let held = false;
  let repeats = 0;
  let backgroundWaiting = false;
  let yielded = false;
  let releaseForeground: (() => void) | undefined;
  const rounds: string[][] = [];
  const fact = "晚安时称呼我为松果。";
  const chat = await startLoopbackChat(async (request, signal) => {
    const tools = request.tools?.map(tool => tool.function.name) ?? [];
    if (!tools.includes("core_add")) {
      if (request.stream && request.messages.at(-1)?.content?.includes("Foreground barrier")) {
        await new Promise<void>(resolve => { releaseForeground = resolve; });
      }
      return fixtureChatReply("收到。");
    }
    rounds.push(tools);
    const input = JSON.parse(request.messages[1].content!) as { entries: string[]; chat: Array<{ text: string }> };
    if (!backgroundWaiting && input.chat.some(line => line.text.includes("Yield background"))) {
      backgroundWaiting = true;
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      yielded = true;
    }
    if (!input.chat.some(line => line.text.includes("长期称呼"))) return fixtureChatReply("Done");
    if (request.messages.at(-1)?.role === "tool") {
      if (!held) {
        held = true;
        await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      }
      return fixtureChatReply("Done");
    }
    if (input.entries.includes(fact)) { repeats++; return fixtureChatReply("Done"); }
    return fixtureChatReply("", { name: "core_add", args: { text: fact } }, { prompt_tokens: 10, completion_tokens: 5 });
  });
  const cli = (...args: string[]) => runControlOmb([...args, "--url", url]);
  const api = (path: string, method = "GET", body?: unknown) => fetch(url + path, {
    method, headers: { origin: url, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const ok = async <T = CoreMemoryView>(path: string, method?: string, body?: unknown): Promise<T> => {
    const response = await api(path, method, body);
    const data = await response.json();
    expect(response.ok, JSON.stringify(data)).toBe(true);
    return data as T;
  };
  let db: DatabaseSync | undefined;
  try {
    await chat.connect(url);
    const { bot } = await cli("new-bot", "--name", "Dream fixture") as { bot: { id: string; activeTaskId: string } };
    const path = "/api/bots/" + bot.id;
    await ok(path, "PATCH", { modelSelection: fixtureChatSelection() });
    await ok(MEMORY_CONNECTION_PATH, "POST", { url: mem.url, token: upstream.serviceToken });
    await ok(path + "/long-term-memory", "PUT", { enabled: true });
    const originalCalls = mem.calls.length;
    mkdirSync(join(dataDir, "bots", bot.id), { recursive: true });
    const file = join(dataDir, "bots", bot.id, "MEMORY.md");
    const header = "# 手写标题\n保留此段。\n";
    writeFileSync(file, header);
    const core = path + "/core-memory";
    await cli("send", "--bot", bot.id, "--text", "长期称呼测试");
    await expect.poll(() => held, { timeout: 20_000 }).toBe(true);
    expect(await ok(core)).toMatchObject({ entries: [fact], maxEntries: 20, maxBytes: 4_000 });
    await fixture.stop();
    await fixture.start();
    await expect.poll(() => repeats, { timeout: 20_000 }).toBe(1);
    db = new DatabaseSync(join(dataDir, "messages.db"), { readOnly: true });
    const progress = () => db!.prepare("SELECT seq, offset FROM dream_cursors WHERE bot_id = ?").get(bot.id);
    await expect.poll(() => {
      const cursor = progress();
      return cursor?.offset === 0 ? Number(cursor.seq) : 0;
    }).toBeGreaterThan(0);
    const before = progress()!.seq;
    expect(readFileSync(file, "utf8")).toBe(header + "- " + fact + "\n");
    await cli("send", "--bot", bot.id, "--text", "一次性任务");
    await cli("wait", "--bot", bot.id, "--timeout", "20");
    await expect.poll(() => Number(progress()?.seq), { timeout: 15_000 }).toBeGreaterThan(Number(before));
    expect(readFileSync(file, "utf8")).toBe(header + "- " + fact + "\n");
    expect(mem.calls).toHaveLength(originalCalls);
    expect(rounds.every(names => names.join(",") === "core_add,core_update,core_remove")).toBe(true);
    for (const request of chat.requests.filter(item => item.stream)) {
      expect(request.tools?.some(tool => tool.function.name.startsWith("core_"))).not.toBe(true);
    }
    for (let n = 1; n < 20; n++) await ok(core, "POST", { action: "add", text: "测试条目" + n });
    expect((await api(core, "POST", { action: "add", text: "超额" })).status).toBe(409);
    let view = await ok(core);
    const oldText = view.entries.at(-1);
    const extra = 4_000 - view.bytes;
    const last = oldText + "中".repeat(Math.floor(extra / 3)) + "x".repeat(extra % 3);
    view = await ok(core, "POST", { action: "update", oldText, text: last });
    expect(view.bytes).toBe(4_000);
    expect((await api(core, "POST", { action: "update", oldText: last, text: last + "x" })).status).toBe(409);
    const stale = await api(core, "POST", { action: "remove", oldText });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ current: { entries: expect.arrayContaining([last]) } });
    const preview = await ok<{ sections: Array<{ id: string; text: string }> }>(path + "/system-prompt");
    expect(preview.sections.find(part => part.id === "memory")?.text).toContain(last);
    await cli("send", "--bot", bot.id, "--task", "new", "--text", "检查新的对话");
    await cli("wait", "--bot", bot.id, "--timeout", "20");
    expect(chat.requests.filter(request => request.stream).at(-1)?.messages.some(line => line.content?.includes(last))).toBe(true);
    expect((await ok(core, "POST", { action: "remove", oldText: last })).entries).toHaveLength(19);
    const { bot: other } = await cli("new-bot", "--name", "Foreground fixture") as { bot: { id: string } };
    await ok("/api/bots/" + other.id, "PATCH", { modelSelection: fixtureChatSelection() });
    await cli("send", "--bot", bot.id, "--text", "Yield background");
    await expect.poll(() => backgroundWaiting, { timeout: 15_000 }).toBe(true);
    await cli("send", "--bot", other.id, "--text", "Foreground barrier");
    await expect.poll(() => yielded && Boolean(releaseForeground), { timeout: 10_000 }).toBe(true);
    releaseForeground!();
    expect(await cli("wait", "--bot", other.id, "--timeout", "20")).toMatchObject({ status: "settled" });
  } finally {
    releaseForeground?.();
    db?.close();
    await fixture.close();
    await chat.close();
    await mem.close();
    vi.unstubAllEnvs();
  }
}, 90_000);
