// Against the real server: the two prompts are assembled in two places, and only the assembled bytes prove they agree.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { fixtureChatText, fixtureModel, startLoopbackChat } from "./testing/loopback-chat.ts";

it("injects only the speaking bot's maintainer notes in a room", async () => {
  const fixture = await launchVerificationServer();
  const provider = await startLoopbackChat();
  const env = { OPENMAUSBOT_URL: fixture.info.url };
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as { [key: string]: unknown };
    expect(response.ok, JSON.stringify(result)).toBe(true);
    return result;
  };
  const prompt = () => {
    const last = provider.requests.findLast(request => request.stream);
    return last ? fixtureChatText(last) : "";
  };
  try {
    await provider.connect(fixture.info.url);
    async function bot(name: string) {
      const { bot } = await runControlOmb(["new-bot", "--name", name], { env }) as { bot: { id: string } };
      await runControlOmb(["set-model", "--bot", bot.id, "--instance", "openaiCompat", "--model", fixtureModel], { env });
      return bot;
    }
    const lead = await bot("Lead");
    const helper = await bot("Helper");
    const leadNote = "The fixture garden is watered on Mondays.";
    const helperNote = "The fixture greenhouse uses an amber checklist.";
    for (const [bot, note] of [[lead, leadNote], [helper, helperNote]] as const) {
      const folder = join(fixture.info.dataDir, "bots", bot.id);
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, "MEMORY.md"), note);
    }
    // A 1:1 turn first: it is the reference the room turn must match.
    await runControlOmb(["send", "--bot", lead.id, "--text", "Remember that the fixture garden is watered on Mondays."], { env });
    await runControlOmb(["wait", "--bot", lead.id, "--timeout", "30"], { env });
    const direct = prompt();
    expect(direct).toContain(leadNote);

    // SAFETY: the groups route returns the created room under `group`
    const { group } = await api("POST", "/api/groups", {
      name: "Garden room", memberIds: [lead.id, helper.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } },
    }) as { group: { id: string } };
    await api("POST", `/api/groups/${group.id}/messages`, { text: "Lead, what day is the garden watered?" });
    await expect.poll(prompt, { timeout: 30_000 }).toContain("Lead, what day is the garden watered?");
    await runControlOmb(["wait", "--channel", group.id, "--timeout", "30"], { env });
    const room = prompt();
    expect(room).toContain(leadNote);
    expect(room).not.toContain(helperNote);
    expect(room).not.toContain("memory_update");
  } finally {
    await fixture.close();
    await provider.close();
  }
}, 120_000);
