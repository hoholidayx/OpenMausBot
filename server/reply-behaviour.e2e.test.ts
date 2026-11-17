import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { REPLY_HABITS_PROMPT } from "./reply-habits.ts";

type Step = { tool: string; arguments: Record<string, unknown> };

it("words a routine plainly and keeps the conversation open after a widget", async () => {
  const fixture = await launchVerificationServer({ TZ: "Asia/Kolkata" },
    undefined, undefined, undefined, undefined, { scripted: true });
  const planPath = join(fixture.info.dataDir, "room-plan.json");
  const evidence = () => existsSync(`${planPath}.evidence.jsonl`)
    ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
  const api = async <T = any>(path: string, method = "GET", body?: unknown, status = 200): Promise<T> => {
    const response = await fetch(fixture.info.url + path, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    expect(response.status, `${method} ${path}`).toBe(status);
    return response.json() as Promise<T>;
  };
  const cli = (...args: string[]) => runControlOmb([...args, "--url", fixture.info.url]) as Promise<any>;
  const turn = async (bot: { id: string; activeTaskId: string }, text: string, steps: Step[], reply: string) => {
    const before = evidence().length;
    writeFileSync(planPath, JSON.stringify({ [bot.id]: { steps, reply } }));
    await cli("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", text);
    await expect.poll(() => evidence().length, { timeout: 20_000 }).toBe(before + 1);
    await cli("wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "20");
    const row = evidence().at(-1);
    return { system: row.system as string, results: (row.evidence as Array<{ step?: Step; response: any }>).filter((entry) => entry.step).map((entry) => String(entry.response?.result?.content?.[0]?.text ?? "")) };
  };
  try {
    const { bot } = await cli("new-bot", "--name", "Memo");

    // Every bot is told how to talk: the preview and a real turn's prompt both carry it.
    const preview = await api<{ sections: Array<{ id: string; text: string }> }>(`/api/bots/${bot.id}/system-prompt`);
    expect(preview.sections.find((section) => section.id === "reply-habits")?.text).toBe(REPLY_HABITS_PROMPT);

    const routine = await turn(bot, "Every weekday at 9am, send me a 5-bullet AI news brief.", [
      { tool: "create_trigger", arguments: { when: "schedule", name: "Weekday AI news brief", instructions: "Send five bullets of the biggest AI news, each with a source link.", schedule: { type: "weekly", time: "09:00", weekdays: ["monday", "tuesday", "wednesday", "thursday", "friday"] } } },
    ], "All set: weekdays at 9:00 AM India time, here in this chat.");
    expect(routine.system).toContain(REPLY_HABITS_PROMPT);
    expect(routine.results[0]).toContain("It applied at once");
    expect(routine.results[0]).toContain("weekdays at 9:00 India time");
    expect(routine.results[0]).not.toMatch(/Asia\/(?:Calcutta|Kolkata)/);
    expect(routine.results[0]).toMatch(/saying the time zone as "India time", never as a zone id; where its results will appear \(here in this chat\); what each run covers; and that the first run is .+ at 9:00 AM India time\.$/);

    // A tap-to-answer question does not hold the chat: typing something else is simply the next message.
    const asking = await turn(bot, "Book a table for 2 tonight at a good Italian place in Bangalore.", [
      { tool: "show_widget", arguments: { widget: { type: "Card", title: "What time works?", caption: "Or just type a time.", children: [{ type: "Row", children: ["7 PM", "8 PM", "9 PM"].map((label) => ({ type: "Button", label, onClickAction: { type: "time", payload: { time: label } } })) }] } } },
    ], "Here are three places with prices for two while you pick a time. Nothing gets booked until you pick a slot.");
    expect(asking.results[0]).toMatch(/^Shown as widget \S+\. Its answer arrives as the person's next message, even while you are still working; if they type something else instead, that is their answer\./);
    const typed = await turn(bot, "Around 8:30 works.", [], "Checking 8:30 at the first place now.");
    expect(typed.results).toEqual([]);
    const messages = (await api(`/api/threads/${bot.activeTaskId}/messages?limit=200`)).messages as Array<{ role: string; text?: string; widget?: { settled?: unknown } }>;
    expect(messages.some((message) => message.role === "bot" && message.text === "Checking 8:30 at the first place now.")).toBe(true);
    // The card stays answerable: a typed reply neither settled nor removed it.
    expect(messages.find((message) => message.widget)?.widget?.settled).toBeUndefined();
  } finally {
    await fixture.close();
  }
}, 240_000);
