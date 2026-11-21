import { MOBILE_API_VERSION, MOBILE_BOOTSTRAP_PATH, type MobileBootstrap } from "../../packages/phone-protocol/src/mobile-v1.ts";
import { botAvatarUrlSchema } from "../../shared/bot-avatar.ts";
import type { VisibleSet } from "../bot-visibility.ts";
import { mainThread } from "../main-thread.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { BotRecord } from "../store.ts";
import { PASS, type RouteHandler } from "./table.ts";

type PartnerRecord = Pick<BotRecord, "id" | "name" | "color" | "avatarUrl" | "hidden" | "sidebarHidden" | "threadId" | "mainThreadChoice">
  & { tasks?: Parameters<typeof mainThread>[0] };

export function visibleBotsInOrder<T extends { id: string }>(ordered: readonly T[], visible: VisibleSet): T[] {
  return ordered.filter((bot) => visible.bot(bot.id));
}

function selectedThread(bot: PartnerRecord, visible: VisibleSet): string | null {
  const tasks = bot.tasks ?? [];
  const selected = tasks.find((task) => task.threadId === bot.threadId && !task.routineRunId);
  if (selected && visible.thread(selected.threadId)) return selected.threadId;
  return mainThread(tasks.filter((task) => visible.thread(task.threadId)), undefined, bot.mainThreadChoice) ?? null;
}

export function mobileBootstrap(ordered: readonly PartnerRecord[], visible: VisibleSet): MobileBootstrap {
  const bots = visibleBotsInOrder(ordered, visible).filter((bot) => !bot.hidden && !bot.sidebarHidden);
  return {
    version: MOBILE_API_VERSION,
    bots: bots.map((bot) => ({
      id: bot.id, name: bot.name, color: bot.color,
      avatarUrl: botAvatarUrlSchema.safeParse(bot.avatarUrl).data ?? null,
      selectedThreadId: selectedThread(bot, visible),
    })),
  };
}

export function createMobileRoutes(orderedBots: (auth: RequestAuth) => readonly PartnerRecord[], visibleFor: (auth: RequestAuth) => VisibleSet): RouteHandler {
  return async ({ method, path, auth, res, json }) => {
    if (method !== "GET" || path !== MOBILE_BOOTSTRAP_PATH) return PASS;
    if (auth.kind !== "session") return json(res, 403, { error: "A paired session is required." });
    res.setHeader("cache-control", "private, no-store");
    return json(res, 200, mobileBootstrap(orderedBots(auth), visibleFor(auth)));
  };
}
