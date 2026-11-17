import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { availableTools, catalogProfileFromEnv } from "./drivers/agents-catalog.ts";

it("injects maintainer notes in direct and room turns while the legacy memory chain stays retired", async () => {
  const fixture = await launchVerificationServer({ OMB_LEGACY_MEMORY: "1" });
  const { url, dataDir } = fixture.info;
  const control = (...args: string[]) => runControlOmb([...args, "--url", url]);
  const input = () => JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
  try {
    const { bot } = await control("new-bot", "--name", "Release Worker") as { bot: { id: string } };
    const trusted = join(dataDir, "bots", bot.id, "MEMORY.md");
    const old = join(dataDir, "workspaces", bot.id);
    const pending = join(dataDir, "memory-capture-pending.json");
    const approved = "The fixture release uses a cobalt checklist.";
    const oldNote = "An unreviewed garnet note.";
    const topic = "The nightly lilac deployment is on Monday.";
    const log = "An old apricot log line.";
    const expired = "Temporary amber decision.";
    const message = "Run the fixture smoke check for the lilac deployment.";
    const seed = '{"batches":[]}';
    mkdirSync(join(dataDir, "bots", bot.id), { recursive: true });
    mkdirSync(join(old, "memory", "log"), { recursive: true });
    const oldLog = join(old, "memory", "log", "2020-01-01.md");
    const trustedText = `- 2020-01-01 · ${expired} · until 2020-01-02\n${approved}\n`;
    writeFileSync(trusted, trustedText);
    writeFileSync(join(old, "MEMORY.md"), oldNote);
    writeFileSync(join(old, "memory", "deploy.md"), topic);
    writeFileSync(oldLog, log);
    writeFileSync(pending, seed);

    await control("send", "--bot", bot.id, "--text", message);
    await control("wait", "--bot", bot.id, "--timeout", "25");
    const direct = input();
    expect(direct.systemPrompt).toContain(approved);
    for (const text of [oldNote, topic, log, expired, "Change MEMORY.md only"]) {
      expect(JSON.stringify([direct.systemPrompt, direct.prompt])).not.toContain(text);
    }
    const tools = availableTools(catalogProfileFromEnv(direct.mcpConfig.mcpServers.agents.env));
    expect(tools.map(({ name }) => name)).toContain("session_search");
    expect(tools.map(({ name }) => name).filter((name) => ["memory_update", "memory_log", "propose_team_memory"].includes(name))).toEqual([]);

    const preview = await fetch(`${url}/api/bots/${bot.id}/system-prompt`);
    expect(preview.ok).toBe(true);
    expect(await preview.json()).toMatchObject({
      sections: expect.arrayContaining([expect.objectContaining({ id: "memory", text: expect.stringContaining(approved) })]),
    });

    const revised = "The maintainer revised the release steps.";
    writeFileSync(trusted, revised);
    await control("send", "--bot", bot.id, "--text", "Continue the fixture smoke check.");
    expect(await control("wait", "--bot", bot.id, "--timeout", "25")).toMatchObject({ status: "settled" });
    const followUp = input();
    expect(JSON.stringify([followUp.systemPrompt, followUp.prompt])).toContain(revised);

    const { channel } = await control("new-channel", "--name", "Release", "--members", bot.id) as { channel: { id: string } };
    const updated = "The maintainer replaced the release checklist.";
    writeFileSync(trusted, updated);
    await control("send-channel", "--channel", channel.id, "--text", "@Release Worker Check the room.");
    expect(await control("wait", "--channel", channel.id, "--timeout", "25")).toMatchObject({ status: "settled" });
    const room = input();
    expect(room.systemPrompt).toContain(updated);
    expect(room.systemPrompt).not.toContain(approved);
    expect(JSON.stringify(room.prompt)).toContain("Check the room.");

    const search = await fetch(`${url}/api/search?q=fixture+smoke+check`);
    expect(search.ok).toBe(true);
    expect(await search.json()).toMatchObject({ hits: expect.arrayContaining([expect.objectContaining({ snippet: message })]) });
    const rejected = await fetch(`${url}/api/bots/${bot.id}/memory/file`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "MEMORY.md", text: "should be refused" }),
    });
    expect(rejected.status).toBe(404);
    expect(readFileSync(trusted, "utf8")).toBe(updated);
    expect(readFileSync(join(old, "MEMORY.md"), "utf8")).toBe(oldNote);
    expect(readFileSync(join(old, "memory", "deploy.md"), "utf8")).toBe(topic);
    expect(readFileSync(oldLog, "utf8")).toBe(log);
    expect(readFileSync(pending, "utf8")).toBe(seed);
    expect(existsSync(join(dataDir, "memory-journal"))).toBe(false);
  } finally {
    await fixture.close();
  }
}, 90_000);
