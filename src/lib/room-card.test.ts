import { beforeEach, describe, expect, it } from "vitest";
import type { CloudRoom, CloudUsage } from "../../electron/cloud-home.mjs";
import { setLocale } from "@/lib/i18n";
import { roomCardBusy, roomCardView, roomCauseText } from "@/lib/room-card";

const usage: CloudUsage = { tier: "starter", resetsAt: Date.UTC(2026, 10, 1), meters: [] };
const room = (over: Partial<CloudRoom> = {}): CloudRoom => ({ id: "offer-1", cause: { kind: "memory", waits: 3, waitMinutes: 6, stopped: 0 }, ...over });
const view = (over: Partial<Parameters<typeof roomCardView>[0]> = {}) => roomCardView({ room: room(), usage, busy: false, hidden: null, usageCardShown: false, ...over });

beforeEach(() => setLocale("en"));

describe("what the card says ran short", () => {
  it("counts the day's waits and stops in plain words", () => {
    const memory = (cause: Partial<Extract<CloudRoom["cause"], { kind: "memory" }>>) => roomCauseText({ kind: "memory", waits: 0, waitMinutes: 0, stopped: 0, ...cause });
    expect(memory({ waits: 3, waitMinutes: 6 })).toBe("3 tasks waited 6 minutes for memory today.");
    expect(memory({ waits: 1, waitMinutes: 1 })).toBe("1 task waited 1 minute for memory today.");
    expect(memory({ waits: 4 })).toBe("4 tasks had to wait for memory today.");
    expect(memory({ stopped: 1 })).toBe("1 task was stopped today to keep everything else running.");
    expect(memory({ waits: 2, waitMinutes: 3, stopped: 2 })).toBe("2 tasks waited 3 minutes for memory today. 2 tasks were stopped today to keep everything else running.");
    // A wait that began before the day still names a task.
    expect(memory({ waitMinutes: 4 })).toBe("1 task waited 4 minutes for memory today.");
    expect(roomCauseText({ kind: "disk", usedGb: 17.25, capGb: 20 })).toBe("17.3 GB of 20 GB used.");
  });
});

describe("the card", () => {

  it("gives a practical tip for memory pressure", () => {
    expect(view({ room: { id: "tip-1", cause: { kind: "memory", waits: 0, waitMinutes: 0, stopped: 2 } } })).toEqual({ id: "tip-1", kind: "memory",
      title: "This Cloud is short on room", cause: "2 tasks were stopped today to keep everything else running.",
      tip: "Run fewer bots at once and close any browsers you’re not using." });
  });

  it("counts a running turn as busy, unless a task is waiting for memory, which is when it speaks", () => {
    expect(roomCardBusy([{ busy: true }, { busy: false }], false)).toBe(true);
    expect(roomCardBusy([{ busy: true }], undefined)).toBe(true);
    expect(roomCardBusy([{ busy: false }], false)).toBe(false);
    expect(roomCardBusy([{ busy: true }], true)).toBe(false);
  });

  it("is never shown mid-turn, after Not now on this offer, beside the usage card, or without a resource alert", () => {
    expect(view({ busy: true })).toBeNull();
    // On a team's Cloud: only an offer about the team's own plan, never one about the person's own Cloud.
    expect(view({ teamHome: true })).toBeNull();
    expect(view({ teamHome: true, usage: { ...usage, tier: "team" } })?.tip).toContain("Run fewer bots");
    expect(view({ hidden: "offer-1" })).toBeNull();
    expect(view({ hidden: "an-older-offer" })).not.toBeNull();
    expect(view({ usageCardShown: true })).toBeNull();
    expect(view({ room: null })).toBeNull();
  });
});
