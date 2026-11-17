import { randomUUID } from "node:crypto";

import type { DecisionRow } from "../decision-log.ts";
import { buildNotification, type Notification } from "../notify.ts";
import { serverLine } from "../server-lines.ts";
import type { BotRecord, GroupRecord, Message, Store } from "../store.ts";

type Write = Extract<NonNullable<NonNullable<Message["card"]>["outsideWrite"]>, { kind: "room-bulletin" }>;
/** A card shows all of what it would save, or it isn't offered. */
const SHOWN_CHARS = 2_000;
const OPEN_CARDS = 5;
const TOOL = "outside_write";

export interface OutsideWriteDeps {
  store: Pick<Store, "appendMessage" | "messagesFor" | "patchMessage" | "botByThread" | "bot" | "group" | "patchGroup">;
  language(threadId: string): string | undefined;
  decide(row: Omit<DecisionRow, "at">): void;
  notify(notification: Notification | null): void;
}

const speaker = (bot: Pick<BotRecord, "id" | "name" | "color">) => ({ botId: bot.id, name: bot.name, color: bot.color });

export function createOutsideWrites(deps: OutsideWriteDeps) {
  const { store } = deps;

  function propose(from: Pick<BotRecord, "id" | "name" | "color">, threadId: string, title: string, subtitle: string, write: Write) {
    if (subtitle.length > SHOWN_CHARS) return { status: 400, body: { error: `This is too long for a person to review on a card: keep it under ${SHOWN_CHARS} characters.` } };
    if (store.messagesFor(threadId).filter((line) => line.card?.outsideWrite && !line.card.answered).length >= OPEN_CARDS) {
      return { status: 429, body: { error: "A person already has several of these to look at from this conversation. Finish without saving more." } };
    }
    const requestId = `outside-write-${randomUUID()}`;
    const language = deps.language(threadId);
    const message = store.appendMessage(threadId, {
      role: "bot", kind: "options", from: speaker(from),
      card: { title, subtitle, options: [serverLine(language, "server.outside.save"), serverLine(language, "server.outside.skip")], requestId, tool: TOOL, outsideWrite: write },
    });
    deps.decide({ threadId, requestId, botId: from.id, botName: from.name, tool: TOOL, summary: title, decision: "card-shown", source: "outside-write" });
    deps.notify(buildNotification("approval", { id: from.id, name: from.name }, threadId, title));
    return { status: 201, body: { status: "proposed", state: "pending", requestId, messageId: message.id, message: "This came from outside work, so it is not saved yet: a person sees a card and decides. Do not wait for it and do not try another way." } };
  }

  return {
    submitBulletin(from: Pick<BotRecord, "id" | "name" | "color">, threadId: string, room: Pick<GroupRecord, "id" | "name">, bulletin: string) {
      return propose(from, threadId, serverLine(deps.language(threadId), "server.outside.bulletinTitle"), `${room.name}: ${bulletin}`, { kind: "room-bulletin", roomId: room.id, bulletin });
    },

    /** A person's answer to the card; null when the request is not one of these cards. */
    resolve(threadId: string, requestId: string, behavior: string): { ok: true; outcome: string; alreadySettled?: true } | null {
      const message = store.messagesFor(threadId).find((line) => line.card?.requestId === requestId && line.card.outsideWrite);
      const card = message?.card;
      const write = card?.outsideWrite;
      if (!message || !card || write?.kind !== "room-bulletin") return null;
      if (card.answered) return { ok: true, outcome: card.answered === "allow" ? "allowed-once" : "rejected", alreadySettled: true };
      const botId = message.from?.botId ?? store.botByThread(threadId)?.id;
      const bot = botId ? store.bot(botId) : undefined;
      const allowed = behavior === "allow";
      const problem = allowed && (!store.group(write.roomId) || !store.patchGroup(write.roomId, { bulletin: write.bulletin }));
      store.patchMessage(threadId, message.id, { card: { ...card, answered: !allowed ? "deny" : problem ? "unavailable" : "allow", ...(problem ? { dismissed: true } : {}) } });
      deps.decide({ threadId, requestId, botId, botName: bot?.name, tool: TOOL, summary: card.title, decision: allowed && !problem ? "user-approved" : "user-denied", source: "user" });
      return { ok: true, outcome: !allowed ? "rejected" : problem ? "unavailable" : "allowed-once" };
    },
  };
}
