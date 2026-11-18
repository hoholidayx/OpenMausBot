import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import type { BotPromptField, BotPromptSetting } from "../shared/bot-prompts.ts";
import { startLoopbackChat, fixtureModel } from "./testing/loopback-chat.ts";
import { REPLY_HABITS_PROMPT } from "./reply-habits.ts";

it("edits prompts for one bot across direct and room turns and restores live defaults", async () => {
  const fixture = await launchVerificationServer();
  const chat = await startLoopbackChat();
  const url = fixture.info.url;
  const cli = (...args: string[]) => runControlOmb([...args, "--url", url]) as Promise<{ bot: { id: string; activeTaskId: string } }>;
  const request = (path: string, method = "GET", body?: unknown) => fetch(url + path, {
    method, headers: { origin: url, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  try {
    const { bot } = await cli("new-bot", "--name", "Ink");
    const { bot: other } = await cli("new-bot", "--name", "Paper");
    await chat.connect(url);
    for (const id of [bot.id, other.id]) await cli("set-model", "--bot", id, "--instance", "openaiCompat", "--model", fixtureModel);
    const path = `/api/bots/${bot.id}/system-prompt`;
    const catalog = async (id: string) => {
      const response = await request(`/api/bots/${id}/system-prompt?editor=1`);
      return (await response.json() as { editable: BotPromptSetting[] }).editable;
    };
    const original = await catalog(bot.id);
    const edit = async (id: BotPromptField, expected: string | null, value: string | null, status = 200) => {
      const defaultText = original.find((part) => part.id === id)!.defaultText;
      const response = await request(path, "PUT", { id, expected, defaultText, value });
      expect(response.status, await response.text()).toBe(status);
    };
    await edit("persona", null, "Fixture archivist.");
    await edit("soul", original.find((f) => f.id === "soul")!.override, "Use the fixture glossary.");
    await edit("reply-habits", null, "Use cheerful fixture prose.");
    await edit("reply-style", null, "Direct fixture style.");
    await edit("room-style", null, "Room fixture style.");
    await edit("reply-habits", null, "Stale change.", 409);
    await edit("reply-habits", "Use cheerful fixture prose.", "汉".repeat(8001), 400);
    expect((await catalog(other.id)).find((f) => f.id === "reply-habits")?.override).toBeNull();

    const evidence = () => chat.requests.filter((r) => r.stream).map((r) => r.messages[0]?.content ?? "");
    const direct = async () => {
      await cli("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "Check the fixture text.");
      await cli("wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "20");
    };
    await direct();
    expect(evidence()[0]).toContain("Fixture archivist.");
    expect(evidence()[0]).toContain("Use the fixture glossary.");
    expect(evidence()[0]).toContain("Direct fixture style.");
    expect(evidence()[0]).toContain("Use cheerful fixture prose.");
    expect(evidence()[0]).not.toContain(REPLY_HABITS_PROMPT);
    const room = await request("/api/groups", "POST", { name: "Reading room", memberIds: [bot.id, other.id],
      setup: { bulletin: "Fixture bulletin.", defaultResponder: { kind: "member", botId: bot.id } } });
    expect(room.ok, await room.clone().text()).toBe(true);
    const { group } = await room.json() as { group: { id: string; threadId: string } };
    expect((await request(`/api/groups/${group.id}/messages`, "POST", { text: "Read the bulletin.", threadId: group.threadId })).ok).toBe(true);
    await expect.poll(() => evidence().length, { timeout: 20_000 }).toBe(2);
    const roomPrompt = evidence()[1];
    for (const part of ["Fixture archivist.", "Use the fixture glossary.", "Use cheerful fixture prose.", "Room fixture style.", "Fixture bulletin."]) {
      expect(roomPrompt).toContain(part);
    }
    expect(roomPrompt).not.toContain("Direct fixture style.");
    await edit("reply-habits", "Use cheerful fixture prose.", "");
    const preview = await (await request(path)).json() as { sections: Array<{ id: string }> };
    expect(preview.sections.some((part) => part.id === "reply-habits")).toBe(false);
    await edit("reply-habits", "", null);
    await direct();
    expect(evidence().at(-1)).toContain(REPLY_HABITS_PROMPT);
    await edit("persona", "Fixture archivist.", null);
    await request(`/api/bots/${bot.id}`, "PATCH", { name: "Pencil" });
    expect((await catalog(bot.id)).find((part) => part.id === "persona")).toMatchObject({ override: null, defaultText: expect.stringContaining("Pencil") });
  } finally {
    await chat.close();
    await fixture.close();
  }
}, 120_000);
