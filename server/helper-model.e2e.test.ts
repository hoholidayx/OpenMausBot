import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

import { EXCERPT_SUMMARY_HEADER } from "../shared/wire.ts";
import { launchVerificationServer, runControlOmb, verificationServerArgs, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { fixtureApi } from "../scripts/testing/preview-fixture.ts";
import { waitForExit } from "./testing/cleanup.ts";

type BotRef = { id: string; activeTaskId: string };
const SUMMARY = "The fixture requires a clean build before release.";

it("ignores retired helper settings and writes summaries only on the conversation's engine", async () => {
  const server = await launchVerificationServer({}, undefined, undefined, undefined, undefined, undefined, ["codex"]);
  const { dataDir, url, logPath } = server.info;
  const api = fixtureApi(url, { headers: { origin: url } });
  const control = (...args: string[]) => runControlOmb([...args, "--url", url]);
  let restarted: ChildProcess | undefined;
  try {
    const { bot: codex } = await control("new-bot", "--name", "Builder") as { bot: BotRef };
    await waitForExit(server.child, { signal: "SIGTERM" });
    const configPath = join(dataDir, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.helper = { instanceId: "claude", model: "claude-haiku-5-5" };
    config.features.llmThreadTitles = false;
    writeFileSync(configPath, JSON.stringify(config));
    const botsPath = join(dataDir, "bots.json");
    const bots = JSON.parse(readFileSync(botsPath, "utf8")) as Array<{ id: string; helperModel?: unknown }>;
    bots.find(bot => bot.id === codex.id)!.helperModel = true;
    writeFileSync(botsPath, JSON.stringify(bots));

    const log = join(dataDir, "summary-prompts.ndjson");
    const reply = join(dataDir, "summary.txt");
    writeFileSync(reply, SUMMARY);
    const env = {
      ...verificationServerEnvironment({ FAKE_CLAUDE_TEXT_FILE: reply, FAKE_CLAUDE_TEXT_LOG: log }, dataDir, Number(new URL(url).port)),
      OMB_HELPER_INSTANCE: "claude",
      OMB_HELPER_MODEL: "claude-haiku-5-5",
    };
    const fd = openSync(logPath, "a", 0o600);
    try { restarted = spawn(process.execPath, verificationServerArgs(env), { env, stdio: ["ignore", fd, fd] }); }
    finally { closeSync(fd); }
    console.info(`Side job evidence: ${logPath}`);
    await expect.poll(async () => {
      try { return (await api("GET", "/api/health")).pid; } catch { return undefined; }
    }, { timeout: 20_000 }).toBe(restarted.pid);

    const listed = await api("GET", "/api/bots?messages=0");
    const loaded = listed.bots.find((bot: { id: string }) => bot.id === codex.id);
    expect(loaded).toMatchObject({ name: "Builder" });
    expect(loaded).not.toHaveProperty("helperModel");
    const { instances } = await control("models") as { instances: Array<{ instanceId: string; models: { default: string } }> };
    const selectModel = (bot: BotRef, instance: string) => control("set-model", "--bot", bot.id, "--instance", instance,
      "--model", instances.find(item => item.instanceId === instance)!.models.default);
    const compact = async (bot: BotRef, text: string) => {
      const wait = () => control("wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "30");
      await control("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", text);
      expect(await wait()).toMatchObject({ status: "settled" });
      await api("POST", `/api/bots/${bot.id}/compact`, { threadId: bot.activeTaskId });
      expect(await wait()).toMatchObject({ status: "settled" });
      const { messages } = await api("GET", `/api/threads/${bot.activeTaskId}/messages`);
      return (messages as Array<{ kind: string; compaction?: { summary: string } }>).findLast(message => message.kind === "compaction")?.compaction?.summary;
    };
    const summaryPrompts = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n")
      .map(line => JSON.parse(line).prompt as string).filter(prompt => prompt.startsWith("Summarize this conversation history")) : [];

    await selectModel(codex, "codex");
    const excerpt = await compact(codex, "CODEX_ONLY_REQ Test the build before release.");
    expect(excerpt?.startsWith(EXCERPT_SUMMARY_HEADER)).toBe(true);
    expect(excerpt).toContain("CODEX_ONLY_REQ");
    expect(summaryPrompts()).toEqual([]);

    const { bot: claude } = await control("new-bot", "--name", "Reviewer") as { bot: BotRef };
    await selectModel(claude, "claude");
    expect(await compact(claude, "CLAUDE_ONLY_REQ Test the build before release.")).toContain(SUMMARY);
    expect(summaryPrompts()).toEqual([expect.stringContaining("CLAUDE_ONLY_REQ")]);
  } finally {
    if (restarted) await waitForExit(restarted, { signal: "SIGTERM" });
    await server.close();
  }
}, 90_000);
