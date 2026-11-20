import { afterEach, expect, it } from "vitest";
import { deleteThread, insertMessage, prepared } from "./message-db.ts";
import { saveDreamCursor, nextDreamBatch } from "./dream-history.ts";

const bot = "dream-history-test";
const threads = ["dream-history-a", "dream-history-b"];
function add(thread: string, id: string, at: number, text: string) {
  insertMessage(thread, { id, at, role: "user", kind: "text", text, parentId: null });
}
afterEach(() => {
  for (const thread of [...threads, "dream-unrelated"]) deleteThread(thread);
  prepared("DELETE FROM dream_cursors WHERE bot_id = ?").run(bot);
});

it("reads a bounded chronological snapshot and resumes Unicode fragments, ties and later imports", () => {
  const large = "中🦊\\\"".repeat(300);
  add(threads[0], "z", 9, large);
  add(threads[1], "a", 9, "same-time second");
  add(threads[0], "early", 6, "earlier");
  add("dream-unrelated", "outside", 5, "other bot");
  const first = nextDreamBatch(bot, threads, 610)!;
  expect(first.lines[0].text).toBe("earlier");
  expect(first.through.offset).toBeGreaterThan(0);
  expect(nextDreamBatch(bot, threads, 610)).toEqual(first);
  saveDreamCursor(bot, first.through);
  add(threads[0], "later-import", 1, "backdated import");
  const lines = [...first.lines];
  for (let i = 0; i < 50; i++) {
    const batch = nextDreamBatch(bot, threads, 610);
    if (!batch) break;
    expect(Buffer.byteLength(JSON.stringify(batch.lines))).toBeLessThanOrEqual(611);
    lines.push(...batch.lines);
    saveDreamCursor(bot, batch.through);
  }
  expect(lines.map(line => line.text).join("")).toBe("earlier" + large + "same-time secondbackdated import");
  expect(lines.some(line => line.continued)).toBe(true);
  expect(nextDreamBatch(bot, threads, 610)).toBeNull();
});

it("keeps its progress when the last processed conversation is deleted and another is imported", () => {
  add(threads[0], "kept", 10, "already processed");
  add(threads[1], "removed", 20, "old conversation");
  const first = nextDreamBatch(bot, threads, 1_600)!;
  saveDreamCursor(bot, first.through);
  deleteThread(threads[1]);
  expect(nextDreamBatch(bot, threads, 1_600)).toBeNull();
  add(threads[0], "imported", 5, "new backdated message");
  expect(nextDreamBatch(bot, threads, 1_600)?.lines.map(line => line.text)).toEqual(["new backdated message"]);
});

it("keeps new imports outside an in-flight snapshot when its highest row is deleted", () => {
  add(threads[0], "first", 10, "first message");
  add(threads[1], "last", 20, "long".repeat(1_000));
  const first = nextDreamBatch(bot, threads, 610)!;
  expect(first.through.offset).toBeGreaterThan(0);
  deleteThread(threads[1]);
  add(threads[0], "new", 2, "read from the start");
  saveDreamCursor(bot, first.through);
  expect(nextDreamBatch(bot, threads, 610)?.lines.map(line => line.text)).toEqual(["read from the start"]);
});

it("preserves human and bot attribution and skips user-role handoffs and automatic requests", () => {
  const message = { at: 10, kind: "text", role: "user", parentId: null } as const;
  insertMessage(threads[0], { ...message, id: "owner", text: "my preference", sender: { name: "Owner" } });
  insertMessage(threads[0], { ...message, id: "handoff", text: "peer request", peerAsk: { botId: "peer", name: "Peer" } });
  insertMessage(threads[0], { ...message, id: "routine", text: "scheduled job", automated: true });
  insertMessage(threads[0], { ...message, id: "aside", text: "mid-turn context", aside: true });
  insertMessage(threads[0], { ...message, role: "bot", id: "reply", text: "acknowledged", from: { botId: "peer", name: "Peer", color: "blue" } });
  expect(nextDreamBatch(bot, threads, 1_600)?.lines.map(({ role, speaker, text }) => [role, speaker, text])).toEqual([
    ["user", "Owner", "my preference"], ["bot", "Peer", "acknowledged"],
  ]);
});
