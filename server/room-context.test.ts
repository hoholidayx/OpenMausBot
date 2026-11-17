import { afterEach, describe, expect, it, vi } from "vitest";

import { RoomContextTracker } from "./room-context.ts";

const IDLE_MS = 10 * 60_000;

describe("room context", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("measures each member per room thread, with the model's window when the driver gave none", () => {
    const rooms = new RoomContextTracker({ idleMs: IDLE_MS });
    rooms.record("room", "scout", { tokens: 0 }, "claude-sonnet-4");
    rooms.record("room", "scout", { tokens: 120_000 }, "claude-sonnet-4");
    rooms.record("room", "pixel", { tokens: 10_000, window: 50_000 }, "anything");
    expect(rooms.forThread("room")).toEqual({
      scout: { tokens: 120_000, window: 200_000 },
      pixel: { tokens: 10_000, window: 50_000 },
    });
    expect(rooms.forThread("other")).toBeUndefined();
  });

  it("clears only the selected member or thread", () => {
    const rooms = new RoomContextTracker({ idleMs: IDLE_MS });
    rooms.record("room", "a", { tokens: 1, window: 100 }, undefined);
    rooms.record("room", "b", { tokens: 2, window: 100 }, undefined);
    rooms.record("other", "a", { tokens: 3, window: 100 }, undefined);
    expect(rooms.clear("room", "a")).toBe(true);
    expect(rooms.forThread("room")).toEqual({ b: { tokens: 2, window: 100 } });
    expect(rooms.forThread("other")).toEqual({ a: { tokens: 3, window: 100 } });
    rooms.forget("room");
    expect(rooms.forThread("room")).toBeUndefined();
  });

  it("expires a reading after the hold is released", () => {
    vi.useFakeTimers();
    let hold = 2 * IDLE_MS;
    const expired = vi.fn();
    const start = Date.now();
    const rooms = new RoomContextTracker({ idleMs: IDLE_MS, now: () => Date.now() - start, heldUntil: () => hold, expired });
    rooms.record("room", "bot", { tokens: 12 }, undefined);
    vi.advanceTimersByTime(IDLE_MS);
    expect(rooms.forThread("room")).toBeDefined();
    hold = IDLE_MS;
    vi.advanceTimersByTime(IDLE_MS);
    expect(rooms.forThread("room")).toBeUndefined();
    expect(expired).toHaveBeenCalledWith("room");
  });
});
