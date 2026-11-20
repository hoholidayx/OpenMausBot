import { expect, it } from "vitest";
import { DotsInbox } from "./inbox.ts";

it("moves a matching Dots inbox binding to the local user only once", () => {
  const inbox = new DotsInbox(":memory:");
  expect(inbox.ownerMatches("old@example.test")).toBe(true);
  expect(inbox.ownerMatches("p_owner", null)).toBe(false);
  expect(inbox.ownerMatches("p_owner", "other@example.test")).toBe(false);
  expect(inbox.ownerMatches("p_owner", "old@example.test")).toBe(true);
  expect(inbox.ownerMatches("p_owner")).toBe(true);
  expect(inbox.ownerMatches("p_other", "old@example.test")).toBe(false);
  expect(inbox.ownerMatches("old@example.test")).toBe(false);
});

it("leaves an unbound inbox untouched when the legacy installation was shared", () => {
  const inbox = new DotsInbox(":memory:");
  expect(inbox.ownerMatches("p_owner", null)).toBe(false);
  expect(inbox.ownerMatches("p_fresh", "local-owner")).toBe(true);
});
