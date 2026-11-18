import { afterEach, expect, it, vi } from "vitest";
import { createConversationCompactor, type CompactionTarget, type ConversationEntry } from "./conversation-compactor.ts";
import type { ConversationSummary } from "./conversation-summary-store.ts";
import type { ChatReplay } from "./contracts.ts";
import type { ReplayEntry } from "./context-rebuild.ts";

const line = (id: string, text = id, role: ReplayEntry["role"] = "user"): ConversationEntry => ({ id, text, role });
const turnText = () => "current request";
const footprint = ({ text, transcript }: ChatReplay) => ({ base: "fixed", tokens: Buffer.byteLength(JSON.stringify([text, transcript])) });

function deferredSummary() {
  let resolve!: (summary: string) => void;
  const promise = new Promise<string>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  let summary: ConversationSummary | undefined;
  const history = [line("one"), line("one-answer", "one-answer", "assistant"), line("two"), line("two-answer", "two-answer", "assistant")];
  const settings = { keepMessages: 2, compactAt: 150, rebuildBytes: 1_024, autoCompact: true, idleCompact: true };
  const target: CompactionTarget = {
    threadId: "thread", botId: "bot", scope: "scope",
    instance: { instanceId: "api", models: { default: "model", options: [{ id: "model", label: "Model", contextWindow: 10_000 }] },
      generateText: vi.fn() },
    read: pending => history.filter(entry => !pending || entry.id !== "pending"),
    valid: vi.fn(() => true), idle: vi.fn(() => true),
  };
  const write = vi.fn(async (..._args: Parameters<Parameters<typeof createConversationCompactor>[0]["write"]>) => "first summary");
  const committed = vi.fn();
  const compactor = createConversationCompactor({
    settings: () => settings,
    store: { read: () => summary, save: (_thread, _bot, next) => { summary = next; },
      forget: vi.fn(), forgetBot: vi.fn() },
    write, committed, contextTooLarge: () => new Error("required context exceeds window"), error: vi.fn(),
  });
  return { compactor, target, history, settings, write, committed, summary: () => summary };
}

afterEach(() => vi.useRealTimers());

it("joins one in-flight idle fold at preflight and excludes pending input from its committed prefix", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const gate = deferredSummary();
  f.write.mockReturnValueOnce(gate.promise);
  const hook = f.compactor.attach(f.target, turnText);
  f.history.push(line("pending", "WAITING_INPUT"));
  hook.completed("model", { tokens: 100, base: "fixed" }, { tokens: 300 });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(f.write).toHaveBeenCalledTimes(1);
  const sending = hook.prepare("model", footprint, new AbortController().signal);
  gate.resolve("ordered summary");
  const next = await sending;
  expect(f.write).toHaveBeenCalledTimes(1);
  expect(f.write.mock.calls[0]![2]).not.toContain("WAITING_INPUT");
  expect(f.committed).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(next)).toContain("ordered summary");
  expect(JSON.stringify(next)).not.toContain("WAITING_INPUT");
  expect(next.text).toBe("current request");
});

it("discards late results after a rewind, a permission change, or Stop", async () => {
  const f = fixture();
  for (const change of ["rewind", "permissions", "stop"]) {
    const gate = deferredSummary();
    f.write.mockReturnValueOnce(gate.promise);
    const writing = f.compactor.manual(f.target, "model");
    await Promise.resolve();
    if (change === "rewind") f.history[0] = line("other");
    if (change === "permissions") vi.mocked(f.target.valid).mockReturnValueOnce(false);
    if (change === "stop") f.compactor.forget(f.target.threadId);
    gate.resolve("stale generation");
    expect(await writing).toBe(false);
    expect(f.summary()).toBeUndefined();
  }
  expect(f.committed).not.toHaveBeenCalled();
});

it("retains an eligible summary, clips oversized optional history on UTF-8 boundaries, and keeps essential content", async () => {
  const f = fixture();
  expect(await f.compactor.manual(f.target, "model")).toBe(true);
  f.history[0] = { ...f.history[0]!, required: true };
  f.history.push(line("large", "START ".concat("中文🐭".repeat(1_500), " LAST")));
  f.write.mockRejectedValueOnce(new Error("provider unavailable"));
  const kept = await f.compactor.attach(f.target, turnText).prepare("model", footprint, new AbortController().signal);
  expect(kept.transcript.some(entry => entry.text.includes("first summary"))).toBe(true);
  expect(kept.transcript).toContainEqual({ role: "user", text: "one", required: true });
  expect(kept.transcript.at(-1)?.text).toMatch(/^START .*Text shortened[\s\S]* LAST$/s);
  expect(kept.transcript.at(-1)?.text).not.toContain("�");
  expect(Buffer.byteLength(JSON.stringify(kept.transcript))).toBeLessThanOrEqual(f.settings.rebuildBytes);
  expect(f.committed).toHaveBeenCalledTimes(1);
  const hugeRequired = f.compactor.attach(f.target, () => "🐭".repeat(10_000));
  await expect(hugeRequired.prepare("model", footprint, new AbortController().signal)).rejects.toThrow("required context exceeds window");
});

it("folds long source separately and bounds each input and saved summary", async () => {
  const f = fixture();
  f.history[0] = line("huge", "foo 🐭".repeat(12_000));
  f.write.mockResolvedValue("摘要🐭".repeat(1_000));
  expect(await f.compactor.manual(f.target, "model")).toBe(true);
  expect(f.write.mock.calls.length).toBeGreaterThan(1);
  expect(f.write.mock.calls.every(([, , prompt]) => Buffer.byteLength(prompt) < 14_000 && !prompt.includes("�"))).toBe(true);
  expect(f.summary()?.summary).not.toContain("�");
  expect(Buffer.byteLength(f.summary()?.summary ?? "")).toBeLessThanOrEqual(6_000);
});

it("uses reported occupancy when keeping history and discards the calibration when the history is folded", async () => {
  const f = fixture();
  f.settings.compactAt = 8_000;
  f.settings.idleCompact = false;
  f.history[0] = line("one", "x".repeat(9_000));
  const hook = f.compactor.attach(f.target, turnText);
  const signal = new AbortController().signal;
  hook.completed("model", { base: "fixed", tokens: 9_200 }, { tokens: 1_900 });
  expect((await hook.prepare("model", footprint, signal)).transcript[0]?.text).toHaveLength(9_000);
  expect(f.write).not.toHaveBeenCalled();

  hook.completed("model", { base: "fixed", tokens: 9_200 }, { tokens: 9_500 });
  f.write.mockRejectedValueOnce(new Error("provider unavailable"));
  expect((await hook.prepare("model", footprint, signal)).transcript.every(entry => entry.text.length < 9_000)).toBe(true);
  expect(await f.compactor.manual(f.target, "model")).toBe(true);
  expect((await hook.prepare("model", footprint, signal)).transcript[0]?.text).toContain("first summary");
});
