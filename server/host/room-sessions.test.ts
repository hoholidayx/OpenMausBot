import { expect, it, vi } from "vitest";

import type { RuntimeEvent } from "../contracts.ts";
import type { RoomSessionReceipt, RoomSessionStore } from "./room-session-store.ts";
import { createRoomSessions, ROOM_DELTA_NONE, type RoomDispatchInput } from "./room-sessions.ts";
import type { RoomLine } from "./room-transcript.ts";

type Row = RoomLine & { from?: string };

function fixture() {
  let sequence = 0;
  const rows: Row[] = [];
  const receipts = new Map<string, RoomSessionReceipt>();
  const key = (threadId: string, botId: string) => threadId + ":" + botId;
  const store: RoomSessionStore = {
    take(threadId, botId) {
      const name = key(threadId, botId);
      const receipt = receipts.get(name);
      receipts.delete(name);
      return receipt;
    },
    save(threadId, botId, receipt) { receipts.set(key(threadId, botId), structuredClone(receipt)); },
    ownsElsewhere(threadId, botId, instanceId, sessionId) {
      return [...receipts].some(([name, receipt]) => name !== key(threadId, botId) && receipt.instanceId === instanceId && receipt.handed.session === sessionId);
    },
    forget(threadId, botId) {
      if (botId) receipts.delete(key(threadId, botId));
      else for (const name of receipts.keys()) if (name.startsWith(threadId + ":")) receipts.delete(name);
    },
    forgetBot(botId) { for (const name of receipts.keys()) if (name.endsWith(":" + botId)) receipts.delete(name); },
    forgetInstance(instanceId) { for (const [name, receipt] of receipts) if (receipt.instanceId === instanceId) receipts.delete(name); },
  };
  const read = (_threadId: string, botId: string): RoomLine[] =>
    rows.map(({ from, ...row }) => ({ ...row, role: from === botId ? "assistant" : "user", turnId: from === botId ? row.turnId : undefined }));
  const interrupt = vi.fn();
  const accepted = vi.fn();
  const open = () => createRoomSessions({ store, read, interrupt });
  let host = open();

  const say = (text: string, options: Partial<Row> = {}) => {
    const row: Row = { id: `row-${++sequence}`, role: "user", text, ...options };
    rows.push(row);
    return row;
  };
  const event = (turnId: string, instanceId: string, threadId: string) => ({
    threadId, provider: "codex" as const, providerInstanceId: instanceId, createdAt: "", eventId: turnId, turnId,
  });
  const dispatch = (botId: string, options: Partial<RoomDispatchInput> = {}) => {
    const id = `turn-${++sequence}`;
    const input: RoomDispatchInput = {
      threadId: "room", claimId: id, botId, instanceId: "engine", fingerprint: botId,
      resumable: () => true, current: () => true, reset: false, stateless: false, budgetBytes: 24_000,
      required: new Set(), lines: read("room", botId), wrap: body => body, onAccepted: accepted, ...options,
    };
    const send = host.dispatch(input);
    const base = event(id, input.instanceId, input.threadId);
    host.observe({ ...base, type: "turn.started" });
    return {
      id, base, input, send,
      started(sessionId: string, rebuilt = false) { host.observe({ ...base, type: "session.started", sessionId, model: null, ...(rebuilt ? { rebuilt: true } : {}) }); },
      done(ok = true, stopped = false, stopReason: string | null = null) { host.complete({ ...base, type: "turn.completed", ok, stopReason, cost: null }, stopped); },
      reply(text: string) { return say(text, { from: botId, turnId: id, assistantText: text }); },
      emit(update: { type: "context.compacted" }) { host.observe({ ...base, ...update }); },
    };
  };
  return { say, dispatch, receipts, interrupt, accepted, rows, restart: () => { host = open(); }, host: () => host, event };
}

it("continues separate sessions through A → B → A and across a host restart", () => {
  const room = fixture();
  const firstLine = room.say("Person: first");
  const first = room.dispatch("A", { required: new Set([firstLine.id]) });
  expect(first.send).toEqual({ text: "Person: first", sessionReset: true });
  first.started("session-A");
  first.reply("A: my reply");
  first.done();

  room.say("Person: request for B");
  const second = room.dispatch("B");
  expect(second.send).toMatchObject({ text: expect.stringContaining("A: my reply"), sessionReset: true });
  second.started("session-B");
  second.reply("B: test result");
  second.done();

  room.restart();
  room.say("Person: back to A");
  const third = room.dispatch("A");
  expect(third.send.resumeCursor).toBe("session-A");
  expect(third.send.text).toContain("Person: request for B\nB: test result\nPerson: back to A");
  expect(third.send.text).not.toMatch(/Person: first|A: my reply/);
  expect(third.send.recoveryText).toContain("A: my reply");
  expect(room.receipts.get("room:B")?.handed.session).toBe("session-B");
  third.done();
  expect(room.receipts.get("room:A")?.handed.session).toBe("session-A");
});

it("uses a successful recovered session's bounded window as its new receipt", () => {
  const room = fixture();
  room.say("ORIGINAL");
  const first = room.dispatch("A");
  first.started("lost");
  first.done();
  room.say("CONTINUE");
  const second = room.dispatch("A");
  expect(second.send.resumeCursor).toBe("lost");
  expect(second.send.recoveryText).toContain("ORIGINAL\nCONTINUE");
  second.started("replacement", true);
  second.reply("RECOVERED_REPLY");
  second.done();
  room.say("NEXT");
  const third = room.dispatch("A");
  expect(third.send.resumeCursor).toBe("replacement");
  expect(third.send.text).not.toMatch(/ORIGINAL|CONTINUE|RECOVERED_REPLY/);
});

it("never reuses a cursor after a dispatch that did not durably finish", () => {
  const room = fixture();
  room.say("prior");
  const first = room.dispatch("A");
  first.started("native");
  first.done();
  room.say("during crash");
  const crashed = room.dispatch("A");
  expect(crashed.send.resumeCursor).toBe("native");
  expect(room.receipts.has("room:A")).toBe(false);
  room.restart();
  const fresh = room.dispatch("A");
  expect(fresh.send).toMatchObject({ sessionReset: true, text: "prior\nduring crash" });
  crashed.done();
  expect(room.receipts.has("room:A")).toBe(false);
});

it.each([
  { ok: false, stopped: false, reason: "rpc_error" },
  { ok: true, stopped: true, reason: null },
  { ok: true, stopped: false, reason: "cancelled" },
])("does not acknowledge an unsuccessful or stopped turn ($reason)", ({ ok, stopped, reason }) => {
  const room = fixture();
  room.say("unsettled");
  const first = room.dispatch("A");
  first.started("A");
  first.done(ok, stopped, reason);
  expect(room.receipts.size).toBe(0);
  expect(room.accepted).not.toHaveBeenCalled();
  expect(room.dispatch("A").send.sessionReset).toBe(true);
});

it("drops receipts on a branch amendment, in-flight edit or changed authority", () => {
  const room = fixture();
  const old = room.say("old words");
  const first = room.dispatch("A");
  first.started("first");
  first.done();
  old.text = "corrected words";
  const rebuilt = room.dispatch("A");
  expect(rebuilt.send).toMatchObject({ sessionReset: true, text: "corrected words" });
  rebuilt.started("rebuilt");
  old.text = "edited again";
  rebuilt.done();
  expect(room.receipts.size).toBe(0);
  const next = room.dispatch("A");
  next.started("current");
  next.done();
  const changed = room.dispatch("A", { fingerprint: "changed tool scope", current: () => false });
  expect(changed.send.sessionReset).toBe(true);
  changed.started("new-scope");
  changed.done();
  expect(room.receipts.size).toBe(0);
});

it("rejects a cursor reported for a different member and an unexplained replacement", () => {
  const room = fixture();
  room.say("one");
  const a = room.dispatch("A");
  a.started("A-native");
  a.done();
  const b = room.dispatch("B");
  b.started("A-native");
  expect(room.interrupt).toHaveBeenCalledWith("room", b.id);
  b.done();
  expect(room.receipts.get("room:A")?.handed.session).toBe("A-native");
  expect(room.receipts.has("room:B")).toBe(false);
  const resumed = room.dispatch("A");
  resumed.started("other", false);
  expect(room.interrupt).toHaveBeenCalledWith("room", resumed.id);
  resumed.done();
  expect(room.receipts.has("room:A")).toBe(false);
  expect(room.accepted).toHaveBeenCalledTimes(1);
});

it("rejects a cursor reserved by a turn on another room thread", () => {
  const room = fixture();
  room.say("one");
  const initial = room.dispatch("A");
  initial.started("native");
  initial.done();

  const resumed = room.dispatch("A");
  expect(resumed.send.resumeCursor).toBe("native");
  expect(room.receipts.size).toBe(0);

  const other = room.dispatch("B", { threadId: "another-room" });
  other.started("native");
  expect(room.interrupt).toHaveBeenCalledWith("another-room", other.id);
  other.done();
  resumed.started("native");
  resumed.done();
  expect(room.receipts.get("room:A")?.handed.session).toBe("native");
  expect(room.receipts.has("another-room:B")).toBe(false);
});

it("can reset one member without discarding another member's receipt", () => {
  const room = fixture();
  room.say("one");
  const a = room.dispatch("A");
  a.started("A");
  a.done();
  const b = room.dispatch("B");
  b.started("B");
  b.done();
  const reset = room.dispatch("A", { reset: true });
  expect(reset.send.sessionReset).toBe(true);
  reset.started("A2");
  reset.emit({ type: "context.compacted" });
  reset.done();
  expect(room.receipts.has("room:A")).toBe(false);
  expect(room.dispatch("B").send.resumeCursor).toBe("B");
});

it("checks the exact turn and instance before acknowledging any delivery", () => {
  const room = fixture();
  room.say("one");
  const one = room.dispatch("A");
  room.host().abandon("room", one.id);
  const two = room.dispatch("A");
  const late: RuntimeEvent = { ...one.base, type: "session.started", sessionId: "late", model: null };
  room.host().observe(late);
  room.host().observe({ ...late, turnId: two.id, providerInstanceId: "different" });
  one.done();
  expect(room.receipts.size).toBe(0);
  two.started("expected");
  two.done();
  expect(room.receipts.get("room:A")?.handed.session).toBe("expected");
});

it("cuts old history, preserves the full current request and old required results, and treats omissions as omissions", () => {
  const room = fixture();
  const held = room.say("HELD_RESULT");
  for (let i = 0; i < 35; i++) room.say(`OLD-${i}: ${"中文".repeat(90)}`);
  const current = room.say("CURRENT:" + "这条不能截断".repeat(450));
  const turn = room.dispatch("A", { budgetBytes: 1_024, required: new Set([held.id, current.id]) });
  expect(turn.send.text).toContain(held.text);
  expect(turn.send.text).toContain(current.text);
  expect(turn.send.text).toContain("earlier messages omitted");
  expect(turn.send.text).not.toMatch(/OLD-0|\uFFFD/);
  turn.started("A");
  turn.done();
  expect(room.receipts.get("room:A")?.earlier).toContain(held.id);
  const next = room.dispatch("A", { required: new Set([held.id]) });
  expect(next.send.text).toBe(ROOM_DELTA_NONE);
});

it("rebuilds when unread history exceeds the byte budget instead of appending an incomplete delta", () => {
  const room = fixture();
  room.say("acked");
  const first = room.dispatch("A");
  first.started("session");
  first.done();
  for (let i = 0; i < 12; i++) room.say("UNREAD-" + i + ":" + "材料".repeat(100));
  const current = room.say("CURRENT");
  const next = room.dispatch("A", { budgetBytes: 1_024, required: new Set([current.id]) });
  expect(next.send).toMatchObject({ sessionReset: true, text: expect.stringContaining("CURRENT") });
  expect(next.send.resumeCursor).toBeUndefined();
  expect(next.send.text).not.toContain("acked");
});

it("gives stateless adapters bounded role history and a separate current user input", () => {
  const room = fixture();
  room.say("Alice: old input");
  room.say("Editor: answer", { from: "A", assistantText: "answer" });
  room.say("Peer: result", { from: "B", assistantText: "result" });
  const current = room.say("Alice: new question");
  const result = room.dispatch("A", { stateless: true, resumable: () => false, required: new Set([current.id]) });
  expect(result.send).toEqual({ sessionReset: true, text: "Alice: new question", transcript: [
    { role: "user", text: "Alice: old input" },
    { role: "assistant", text: "answer" },
    { role: "user", text: "Peer: result" },
  ] });
  result.done();
  expect(room.receipts.size).toBe(0);
});

it("keeps posts during a turn for the next input even if the reply was already acknowledged", () => {
  const room = fixture();
  room.say("original");
  const first = room.dispatch("A");
  first.started("A");
  room.say("teammate post");
  first.reply("own reply");
  first.done();
  const next = room.dispatch("A");
  expect(next.send.resumeCursor).toBe("A");
  expect(next.send.text).toContain("teammate post");
  expect(next.send.text).not.toContain("own reply");
});
