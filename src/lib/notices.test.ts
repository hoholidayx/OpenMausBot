import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EMPTY_ONBOARDING } from "@/lib/onboarding";
import { dismissNotice, dismissNotices, GROK_MOVE_NOTICE, launchNotice, markLaunchNotice, nextNotice, noticeSeen, NOTICES, PHONE_UPDATE_NOTICE, phoneUpdateHint, SIMPLE_MODE_NOTICE, type NoticeFacts } from "./notices";

let storage: Map<string, string>;
const record = (hintsSeen: string[] = []) => ({ ...EMPTY_ONBOARDING, hintsSeen });

beforeEach(() => {
  storage = new Map();
  const fake = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) };
  vi.stubGlobal("localStorage", fake);
  vi.stubGlobal("sessionStorage", fake);
});
afterEach(() => vi.unstubAllGlobals());

const facts: NoticeFacts = {
  [GROK_MOVE_NOTICE]: false, [PHONE_UPDATE_NOTICE]: false, [SIMPLE_MODE_NOTICE]: false,
};

it("chooses notices in queue order and waits while an earlier notice is unresolved", () => {
  const all = Object.fromEntries(NOTICES.map(id => [id, true])) as NoticeFacts;
  expect(nextNotice(all)).toBe(GROK_MOVE_NOTICE);
  expect(nextNotice({ ...all, [GROK_MOVE_NOTICE]: false })).toBe(PHONE_UPDATE_NOTICE);
  expect(nextNotice({ ...all, [GROK_MOVE_NOTICE]: null })).toBeNull();
});

it("keeps the first notice for the launch and stops the queue once it is dismissed", () => {
  markLaunchNotice(PHONE_UPDATE_NOTICE);
  markLaunchNotice(SIMPLE_MODE_NOTICE);
  expect(launchNotice()).toBe(PHONE_UPDATE_NOTICE);
  const due = { ...facts, [PHONE_UPDATE_NOTICE]: true, [SIMPLE_MODE_NOTICE]: true };
  expect(nextNotice(due, launchNotice())).toBe(PHONE_UPDATE_NOTICE);
  expect(nextNotice(due, launchNotice(), true)).toBeNull();
});
it("a dismissal holds on this device at once and in the workspace record for good", () => {
  const seen = record(["tour.done"]);
  expect(dismissNotice(seen, GROK_MOVE_NOTICE)).toEqual({ onboarding: { hintsSeen: ["tour.done", GROK_MOVE_NOTICE] } });
  expect(storage.get(GROK_MOVE_NOTICE)).toBe("1");
  expect(noticeSeen(record(), GROK_MOVE_NOTICE)).toBe(true);
  storage.clear();
  expect(noticeSeen(record(), GROK_MOVE_NOTICE)).toBe(false);
  expect(noticeSeen(record([GROK_MOVE_NOTICE]), GROK_MOVE_NOTICE)).toBe(true);
  expect(dismissNotice(record([GROK_MOVE_NOTICE]), GROK_MOVE_NOTICE)).toBeNull();
});

it("browser storage that throws still leaves the workspace record in charge", () => {
  vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
  expect(noticeSeen(record(), GROK_MOVE_NOTICE)).toBe(false);
  expect(noticeSeen(record([GROK_MOVE_NOTICE]), GROK_MOVE_NOTICE)).toBe(true);
  expect(dismissNotice(record(), GROK_MOVE_NOTICE)).toEqual({ onboarding: { hintsSeen: [GROK_MOVE_NOTICE] } });
});

it("an Update MausBot on your phone dismissal is kept per phone, in short hints, all in one patch", () => {
  expect(phoneUpdateHint("0f8c2a41-1111-4222-8333-444455556666")).toBe("phone-app-update:0f8c2a41");
  expect(phoneUpdateHint("0f8c2a41-1111-4222-8333-444455556666").length).toBeLessThanOrEqual(60);
  const ids = [phoneUpdateHint("aaaaaaaa-1"), phoneUpdateHint("bbbbbbbb-2")];
  expect(dismissNotices(record(["star"]), ids)).toEqual({ onboarding: { hintsSeen: ["star", ...ids] } });
  for (const id of ids) expect(noticeSeen(undefined, id)).toBe(true);
  expect(dismissNotices(record(ids), ids), "nothing new").toBeNull();
  expect(dismissNotices(record([ids[0]!]), [...ids, ids[1]!])).toEqual({ onboarding: { hintsSeen: ids } });
});
