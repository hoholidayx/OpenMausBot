import { expect, it } from "vitest";
import { DotsInbox } from "./inbox.ts";

it("binds the inbox to one installation owner", () => {
  const inbox = new DotsInbox(":memory:");
  expect(inbox.ownerMatches("p_owner")).toBe(true);
  expect(inbox.ownerMatches("p_other")).toBe(false);
  expect(inbox.ownerMatches("p_owner")).toBe(true);
});

it("requires an owner binding before an installed inbox can be opened", () => {
  const inbox = new DotsInbox(":memory:");
  inbox.markInstalled();
  expect(inbox.ownerMatches("p_owner")).toBe(false);
});
