// Display only: the usage meter never grants or limits anything; the Cloud's own relays do.
import type { CloudUsage, CloudUsageKind, CloudUsageMeter } from "../../electron/cloud-home.mjs";
import { usd } from "@/lib/cloud-plan";
import { activeLocale, t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";

export const NEAR_LIMIT_PERCENT = 80;
export const CARD_METERS = 2;
export const TEAM_TIERS: readonly string[] = ["team", "business"];

export type MeterBand = "ok" | "near" | "full";

export function meterPercent(meter: Pick<CloudUsageMeter, "used" | "max" | "usedUp">): number {
  if (meter.usedUp || meter.used >= meter.max) return 100;
  if (!(meter.max > 0) || !(meter.used > 0)) return 0;
  return Math.min(99, Math.floor((meter.used / meter.max) * 100));
}

export function includedUsePercent(usage: Pick<CloudUsage, "meters">): number {
  return usage.meters.reduce((most, meter) => Math.max(most, meterPercent(meter)), 0);
}

export function meterBand(percent: number): MeterBand {
  return percent >= 100 ? "full" : percent >= NEAR_LIMIT_PERCENT ? "near" : "ok";
}

export function tightMeters(usage: CloudUsage, limit = CARD_METERS): CloudUsageMeter[] {
  return usage.meters
    .map((meter, index) => ({ meter, index, percent: meterPercent(meter) }))
    .filter(({ percent }) => percent >= NEAR_LIMIT_PERCENT)
    .sort((a, b) => b.percent - a.percent || a.index - b.index)
    .slice(0, limit)
    .map(({ meter }) => meter);
}

export function usageCardView(input: { usage: CloudUsage | null | undefined; teamHome: boolean; dismissed: string | null }):
  { meters: CloudUsageMeter[]; band: Exclude<MeterBand, "ok">; dismissKey: string } | null {
  const { usage } = input;
  if (!usage) return null;
  if (input.teamHome && !TEAM_TIERS.includes(usage.tier)) return null;
  const meters = tightMeters(usage);
  if (!meters.length) return null;
  const band = meters.some((meter) => meterPercent(meter) >= 100) ? "full" : "near";
  const dismissKey = `${usage.resetsAt}:${band}`;
  return input.dismissed === dismissKey ? null : { meters, band, dismissKey };
}

const DISMISS_KEY = "openmausbot.usageCard.dismissed.v1";
export function readUsageCardDismissed(): string | null {
  try { return globalThis.localStorage?.getItem(DISMISS_KEY) ?? null; } catch { return null; }
}
export function rememberUsageCardDismissed(key: string): void {
  try { globalThis.localStorage?.setItem(DISMISS_KEY, key); } catch { /* A card dismissed only until reload. */ }
}

const LABEL: Record<CloudUsageKind, LocaleKey> = {
  computerHours: "usageMeter.kind.computerHours", voice: "usageMeter.kind.voice", decisions: "usageMeter.kind.decisions",
  x: "usageMeter.kind.x", research: "usageMeter.kind.research", storage: "usageMeter.kind.storage",
};
export const meterLabel = (kind: CloudUsageKind) => t(LABEL[kind]);

const number = (value: number, digits = 0) => new Intl.NumberFormat(activeLocale(), { maximumFractionDigits: digits }).format(value);
export function meterAmounts(meter: CloudUsageMeter): string {
  const used = Math.min(meter.used, meter.max);
  switch (meter.kind) {
    case "computerHours": return t("usageMeter.amount.hours", { used: number(used, 1), max: number(meter.max) });
    case "voice": return t("usageMeter.amount.characters", { used: number(used), max: number(meter.max) });
    case "decisions": return t("usageMeter.amount.decisions", { used: number(used), max: number(meter.max) });
    case "x": return t("usageMeter.amount.calls", { used: number(used), max: number(meter.max) });
    case "research": return t("usageMeter.amount.dollars", { used: usd(used), max: usd(meter.max) });
    case "storage": return t("usageMeter.amount.gb", { used: number(used, 1), max: number(meter.max) });
  }
}

const shortDate = (value: number) => new Intl.DateTimeFormat(activeLocale(), { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(value));
export function resetLine(usage: CloudUsage): string {
  return usage.trialEndsAt ? t("usageMeter.trialFull", { date: shortDate(usage.trialEndsAt) }) : t("usageMeter.resets", { date: shortDate(usage.resetsAt) });
}
