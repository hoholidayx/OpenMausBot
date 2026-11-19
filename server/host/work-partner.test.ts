import { expect, it, vi } from "vitest";
import type { Message } from "../store.ts";
import { appendAtRequest } from "./work-partner.ts";

it("keeps a late result on the originating branch and drops a result whose request was removed", () => {
  const message = (id: string, parentId?: string): Message => ({ id, parentId, at: 0, role: "user", kind: "text", text: id });
  const first = message("first");
  const original = message("original", first.id);
  const earlier = message("original-reply", original.id);
  const alternate = message("alternate", first.id);
  const store = {
    messagesFor: () => [first, original, earlier, alternate],
    activePath: () => [first, alternate],
    appendMessage: vi.fn(() => message("appended")),
    insertMessageAfter: vi.fn(() => message("inserted")),
  };
  const result = { role: "bot", kind: "text", text: "Finished" } as const;
  expect(appendAtRequest(store, "chat", original.id, result)).toBe(false);
  expect(store.insertMessageAfter).toHaveBeenCalledExactlyOnceWith("chat", earlier.id, result);
  expect(appendAtRequest(store, "chat", "deleted", result)).toBe(false);
  expect(store.appendMessage).not.toHaveBeenCalled();
  expect(store.insertMessageAfter).toHaveBeenCalledTimes(1);
});
