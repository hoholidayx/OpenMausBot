import { expect, it } from "vitest";
import { legacyOwnerKey } from "./sign-in-env.ts";

it("recognizes only one explicit historic owner, including legacy environment overrides", () => {
  expect(legacyOwnerKey({}, {})).toBe("local-owner");
  expect(legacyOwnerKey({ admins: ["a@b.test"] }, { OMB_SIGNIN_EMAILS: "" })).toBe("a@b.test");
  expect(legacyOwnerKey({}, { OMB_SIGNIN_EMAILS: " Owner@Example.test " })).toBe("owner@example.test");
  expect(legacyOwnerKey({ admins: ["one@test,other@test"] }, {})).toBeNull();
  expect(legacyOwnerKey({ admins: ["@example.test"] }, {})).toBeNull();
  expect(legacyOwnerKey({ members: ["someone@example.test"] }, {})).toBeNull();
  expect(legacyOwnerKey({}, { OMB_SIGNIN_MEMBER_EMAILS: "someone@example.test" })).toBeNull();
});
