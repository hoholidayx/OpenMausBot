import type { CloudRoom, CloudUsage } from "../../electron/cloud-home.mjs";
import { activeLocale, t } from "@/lib/i18n";
import { TEAM_TIERS } from "@/lib/usage-meter";

export interface RoomCardView {
  id: string;
  kind: "memory" | "disk";
  title: string;
  /** What ran short, in the person's own numbers. */
  cause: string;
  tip: string;
}

const count = (value: number, one: Parameters<typeof t>[0], many: Parameters<typeof t>[0]) => value === 1 ? t(one) : t(many, { count: String(value) });
const gb = (value: number) => new Intl.NumberFormat(activeLocale(), { maximumFractionDigits: 1 }).format(value);

export function roomCauseText(cause: CloudRoom["cause"]): string {
  if (cause.kind === "disk") return t("roomCard.cause.disk", { used: gb(cause.usedGb), cap: gb(cause.capGb) });
  // A wait that began before the day counts its minutes but not its start.
  const waits = Math.max(cause.waits, cause.waitMinutes > 0 ? 1 : 0), tasks = count(waits, "roomCard.tasks.one", "roomCard.tasks.many");
  const waited = waits === 0 ? null : cause.waitMinutes > 0
    ? t("roomCard.cause.waited", { tasks, minutes: count(cause.waitMinutes, "roomCard.minutes.one", "roomCard.minutes.many") })
    : t("roomCard.cause.waitedBriefly", { tasks });
  const stopped = cause.stopped === 0 ? null : count(cause.stopped, "roomCard.cause.stopped.one", "roomCard.cause.stopped.many");
  return [waited, stopped].filter(Boolean).join(" ");
}

/** Mid-turn counts as busy, unless a task is waiting for memory: that wait is the moment this card is about. */
export const roomCardBusy = (bots: readonly { busy?: boolean }[], waitingForRoom: boolean | undefined): boolean => !waitingForRoom && bots.some((bot) => bot.busy);

/**
 * The card, or null while there is nothing to show now: no resource alert, a turn running anywhere (never shown mid-turn), the person
 * dismissed this alert, the usage meter's card is showing (one card at a time), or this is a team's Cloud and
 * the alert is about the person's own plan's Cloud, not the team's.
 */
export function roomCardView(input: { room: CloudRoom | null | undefined; usage: CloudUsage | null; busy: boolean; hidden: string | null; usageCardShown: boolean;
  teamHome?: boolean }): RoomCardView | null {
  const { room } = input;
  if (!room || input.busy || input.hidden === room.id || input.usageCardShown) return null;
  if (input.teamHome && !TEAM_TIERS.includes(input.usage?.tier ?? "")) return null;
  const kind = room.cause.kind;
  return { id: room.id, kind, title: t(kind === "disk" ? "roomCard.title.disk" : "roomCard.title.memory"), cause: roomCauseText(room.cause),
    tip: t(kind === "disk" ? "roomCard.tip.disk" : "roomCard.tip.memory") };
}

const HIDDEN_KEY = "openmausbot.roomCard.hidden.v1";
export function readRoomCardHidden(): string | null {
  try { return globalThis.localStorage?.getItem(HIDDEN_KEY) ?? null; } catch { return null; }
}
export function rememberRoomCardHidden(id: string): void {
  try { globalThis.localStorage?.setItem(HIDDEN_KEY, id); } catch { /* Hidden only until reload. */ }
}
