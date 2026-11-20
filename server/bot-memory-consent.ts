import { randomUUID } from "node:crypto";
import { optionCardsForTools } from "./message-db.ts";
import type { Store } from "./store.ts";
import { turnWaitedOnPerson } from "./waiting-on-person.ts";

export const MEMORY_DELETE_CARD = "maus_memory_delete";

export function createMemoryConsent(store: Store) {
  const pending = new Map<string, (allow: boolean, dismissed?: boolean) => void>();
  return {
    confirm(botId: string, threadId: string, id: string, title: string, signal: AbortSignal): Promise<boolean> {
      const until = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
      if (until.aborted) return Promise.resolve(false);
      const requestId = randomUUID();
      const message = store.appendMessage(threadId, { role: "bot", kind: "options", card: {
        title, subtitle: id, options: ["Allow once", "Deny"], requestId, requestType: "permission", tool: MEMORY_DELETE_CARD,
      } });
      if (store.projectBotForTask(botId, threadId)?.busy) store.setTaskActivity(botId, threadId, "waiting-on-you");
      return new Promise(resolve => {
        const stop = () => settle(false, true);
        function settle(allow: boolean, dismissed = false) {
          if (!pending.delete(requestId)) return;
          until.removeEventListener("abort", stop);
          store.patchMessage(threadId, message.id, { card: { ...message.card!, answered: allow ? "allow" : "deny", dismissed } });
          if (turnWaitedOnPerson(store.projectBotForTask(botId, threadId))) store.setTaskActivity(botId, threadId, "working");
          resolve(allow);
        }
        pending.set(requestId, settle);
        until.addEventListener("abort", stop, { once: true });
        if (until.aborted) stop();
      });
    },
    answer(requestId: string, behavior: string) {
      const settle = pending.get(requestId);
      settle?.(behavior === "allow");
      return Boolean(settle);
    },
    dismissStale() {
      for (const { threadId, messageId } of optionCardsForTools([MEMORY_DELETE_CARD])) {
        const card = store.messagesFor(threadId).find(row => row.id === messageId)?.card;
        if (card && !card.answered && !card.dismissed) store.patchMessage(threadId, messageId, { card: { ...card, answered: "deny", dismissed: true } });
      }
    },
  };
}
