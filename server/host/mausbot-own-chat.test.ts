import { describe, expect, it } from "vitest";

import { createMausBotOwnChat } from "./mausbot-own-chat.ts";

const key = (email: string) => `key:${email}`;
function world(starters: Record<string, string> = {}) {
  const bots = [
    { id: "maus-mira", threadId: "t-mira", defaultBot: { person: "Mira@Acme.test" } },
    { id: "maus-place", threadId: "t-place", defaultBot: {} },
    { id: "sales", threadId: "t-sales" },
  ];
  const own = createMausBotOwnChat({
    bots: () => bots,
    starters: { get: (threadId) => starters[threadId], set: (threadId, person) => { starters[threadId] = person; } },
    personKey: key,
  });
  return { own, starters, bots };
}

describe("a member's own MausBot's main chat", () => {
  it("becomes its person's", () => {
    const w = world();
    expect(w.own.claimAll()).toBe(1);
    expect(w.starters).toEqual({ "t-mira": "key:mira@acme.test" });
  });

  it("marks the chat when the bot is created", () => {
    const w = world();
    void w.own.claim(w.bots[0]!);
    expect(w.starters["t-mira"]).toBe("key:mira@acme.test");
  });

  it("leaves a chat that already has its person, a place's own MausBot and every other bot alone", () => {
    const w = world({ "t-mira": "key:someone" });
    expect(w.own.claimAll()).toBe(0);
    expect(w.own.claim(w.bots[1]!)).toBe(false);
    expect(w.own.claim(w.bots[2]!)).toBe(false);
    expect(w.starters).toEqual({ "t-mira": "key:someone" });
  });
});
