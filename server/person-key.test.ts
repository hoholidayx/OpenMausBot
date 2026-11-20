import { expect, it } from "vitest";
import { lendingPerson, lendingPersonKey, localUserId, OWN_SERVER_LENDER, personKey } from "./person-key.ts";

it("shares one owner and the stored lender identity between devices of the same installation", () => {
  const userId = localUserId("first");
  const desktop = { id: "desktop", userId }, phone = { id: "phone", userId };
  expect(localUserId("second")).not.toBe(userId);
  expect(personKey(desktop)).toBe(personKey(phone));
  expect(lendingPersonKey(desktop, userId)).toBe(OWN_SERVER_LENDER);
  expect(lendingPerson(userId, userId, () => [])).toBe(OWN_SERVER_LENDER);
  const oldKey = personKey({ id: desktop.id });
  expect(lendingPerson(oldKey, userId, () => [desktop])).toBe(OWN_SERVER_LENDER);
  expect(lendingPerson(oldKey, userId, () => [])).toBe(oldKey);
  const limited = { id: "limited" };
  expect(lendingPersonKey(limited, userId)).toBe(personKey(limited));
  const legacyMember = personKey({ id: "", email: "member@example.test" });
  expect(lendingPerson(legacyMember, userId, () => [desktop, phone])).toBe(legacyMember);
});
