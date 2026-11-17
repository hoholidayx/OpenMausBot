import { api } from "@/state/store";
import { intlLocale, t } from "@/lib/i18n";

export type MemoryActor = "bot" | "person" | "import" | "upkeep";

export interface MemoryJournalRow {
  id: string;
  at: number;
  botId: string;
  path: string;
  actor: MemoryActor;
  via: string;
  threadId?: string;
  threadTitle?: string;
  kind: "created" | "edited" | "deleted";
  beforeHash: string | null;
  afterHash: string | null;
  diff: string;
  added: number;
  removed: number;
  canRevert: boolean;
  revertUnavailableReason?: string;
}

export function fetchSoulChanges(botId: string): Promise<{ rows: MemoryJournalRow[]; revision: string }> {
  return api(`/api/bots/${botId}/history?view=changes&limit=20`);
}

export function undoSoulChange(botId: string, id: string, expectedRevision: string): Promise<unknown> {
  return api(`/api/bots/${botId}/history/rollback`, { method: "POST", body: JSON.stringify({ id, expectedRevision }) });
}

export function relativeTime(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return t("remote.time.justNow");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t("remote.time.minutes", { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t("time.hoursAgo", { count: hours });
  const days = Math.round(hours / 24);
  if (days === 1) return t("time.yesterday");
  if (days < 7) return t("time.daysAgo", { count: days });
  return new Date(at).toLocaleDateString(intlLocale(), { month: "short", day: "numeric" });
}

export function journalSource(row: MemoryJournalRow): string | null {
  if (row.via === "revert") return "undo";
  if (row.via === "disk") return "changed outside the app";
  if (row.threadTitle) return `from chat “${row.threadTitle}”`;
  if (row.actor === "bot") return "during a task";
  if (row.via === "ui") return "in Settings";
  if (row.via === "api") return "through the API";
  return null;
}

export function journalSourceKey(row: MemoryJournalRow): "memory.source.undo" | "memory.source.disk" | "memory.source.chat" | "memory.source.task" | "memory.source.settings" | "memory.source.api" | null {
  if (row.via === "revert") return "memory.source.undo";
  if (row.via === "disk") return "memory.source.disk";
  if (row.threadTitle) return "memory.source.chat";
  if (row.actor === "bot") return "memory.source.task";
  if (row.via === "ui") return "memory.source.settings";
  if (row.via === "api") return "memory.source.api";
  return null;
}
