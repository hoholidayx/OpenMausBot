import { describe, expect, it, vi } from "vitest";

import type { BotRecord } from "../store.ts";
import { createOutsideWrites, type OutsideWriteDeps } from "./outside-writes.ts";

const bot = { id: "chief", name: "Clive", color: "#123" } as unknown as Pick<BotRecord, "id" | "name" | "color">;
const requestOf = (proposed: { body: object }) => (proposed.body as { requestId: string }).requestId;

function world() {
  const lines: Array<{ id: string; from?: { botId: string }; card?: Record<string, any> }> = [];
  const groups = new Map([["room", { id: "room", name: "Ops", bulletin: "as it was" }]]);
  const store = {
    appendMessage: (_threadId: string, row: any) => { const line = { ...row, id: `m${lines.length}` }; lines.push(line); return line; },
    messagesFor: () => lines,
    patchMessage: (_threadId: string, id: string, patch: any) => { Object.assign(lines.find((line) => line.id === id)!, patch); },
    botByThread: () => bot, bot: () => bot,
    group: (id: string) => groups.get(id),
    patchGroup: (id: string, patch: { bulletin: string }) => { const group = groups.get(id); if (group) Object.assign(group, patch); return group; },
  } as unknown as OutsideWriteDeps["store"];
  const decide = vi.fn();
  const writes = createOutsideWrites({ store, language: () => undefined, decide, notify: () => {} });
  return { writes, lines, groups, decide };
}

describe("what work from outside writes where later turns read it waits on a card", () => {
  it("leaves a room's bulletin as it was until a person says yes", () => {
    const w = world();
    const proposed = w.writes.submitBulletin(bot, "hook-run", { id: "room", name: "Ops" }, "new text");
    expect(proposed.body).toMatchObject({ state: "pending" });
    expect(w.groups.get("room")!.bulletin).toBe("as it was");
    expect(w.lines[0]!.card).toMatchObject({ options: ["Save", "Skip"], outsideWrite: { kind: "room-bulletin", roomId: "room", bulletin: "new text" } });
    expect(w.writes.resolve("hook-run", requestOf(proposed), "allow")).toMatchObject({ outcome: "allowed-once" });
    expect(w.groups.get("room")!.bulletin).toBe("new text");
    expect(w.lines[0]!.card!.answered).toBe("allow");
  });

  it("writes nothing when a person skips it, and answers twice as once", () => {
    const w = world();
    const proposed = w.writes.submitBulletin(bot, "hook-run", { id: "room", name: "Ops" }, "a note");
    expect(w.writes.resolve("hook-run", requestOf(proposed), "deny")).toMatchObject({ outcome: "rejected" });
    expect(w.writes.resolve("hook-run", requestOf(proposed), "allow")).toMatchObject({ alreadySettled: true, outcome: "rejected" });
  });

  it("shows all of what it would save, or doesn't offer it", () => {
    const w = world();
    expect(w.writes.submitBulletin(bot, "hook-run", { id: "room", name: "Ops" }, "x".repeat(2_001)).status).toBe(400);
    expect(w.lines).toEqual([]);
    const fits = w.writes.submitBulletin(bot, "hook-run", { id: "room", name: "Ops" }, "x".repeat(1_900));
    expect(w.lines[0]!.card!.subtitle).toBe(`Ops: ${"x".repeat(1_900)}`);
    expect(fits.status).toBe(201);
  });

  it("offers a person only a few at a time from one conversation", () => {
    const w = world();
    for (let i = 0; i < 5; i++) expect(w.writes.submitBulletin(bot, "hook-run", { id: "room", name: "Ops" }, `note ${i}`).status).toBe(201);
    expect(w.writes.submitBulletin(bot, "hook-run", { id: "room", name: "Ops" }, "one more").status).toBe(429);
    expect(w.lines).toHaveLength(5);
    w.writes.resolve("hook-run", w.lines[0]!.card!.requestId, "deny");
    expect(w.writes.submitBulletin(bot, "hook-run", { id: "room", name: "Ops" }, "now it fits").status).toBe(201);
  });

  it("reports failure when the room disappeared before approval", () => {
    const w = world();
    const proposed = w.writes.submitBulletin(bot, "hook-run", { id: "room", name: "Ops" }, "a new bulletin");
    w.groups.delete("room");
    expect(w.writes.resolve("hook-run", requestOf(proposed), "allow")).toMatchObject({ outcome: "unavailable" });
    expect(w.lines[0]!.card!.answered).toBe("unavailable");
  });

  it("leaves other cards to whoever owns them", () => {
    expect(world().writes.resolve("hook-run", "someone-elses", "allow")).toBeNull();
  });
});
