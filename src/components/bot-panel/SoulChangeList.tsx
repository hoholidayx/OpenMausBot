import { RotateCcw } from "lucide-react";

import { activeLocale, t } from "@/lib/i18n";
import { journalSource, journalSourceKey, type MemoryJournalRow } from "@/lib/memory";
import { localizedRelativeTime } from "@/lib/relative-time";

function localizedJournalSummary(row: MemoryJournalRow, botName: string): string {
  const who = row.via === "team-setup" ? t("memory.journal.actor.teamSetup") : row.actor === "bot" ? botName
    : row.actor === "import" ? t("memory.journal.actor.import") : row.actor === "upkeep" ? t("memory.journal.actor.upkeep") : t("memory.journal.actor.you");
  const topic = t("memory.journal.instructions");
  const lines = (count: number) => t(count === 1 ? "memory.journal.line.one" : "memory.journal.line.many", { count });
  if (row.kind === "created") return t("memory.journal.created", { who, topic, detail: row.added ? t("memory.journal.withLines", { lines: lines(row.added) }) : "" });
  if (row.kind === "deleted") return t("memory.journal.deleted", { who, topic });
  if (row.added && !row.removed) return t("memory.journal.added", { who, lines: lines(row.added), topic });
  if (row.removed && !row.added) return t("memory.journal.removed", { who, lines: lines(row.removed), topic });
  return t("memory.journal.rewrote", { who, lines: lines(Math.max(row.added, row.removed)), topic });
}

export function SoulChangeList({
  rows,
  botName,
  reverting,
  onRevert,
  now = Date.now(),
}: {
  rows: MemoryJournalRow[] | null;
  botName: string;
  reverting: string | null;
  onRevert: (row: MemoryJournalRow) => void;
  now?: number;
}) {
  if (!rows) return <div className="text-[13px] text-ink-secondary">{t("memory.loading")}</div>;
  if (rows.length === 0) return <div className="text-[13px] text-ink-secondary">{t("memory.noChanges")}</div>;
  return (
    <div className="flex flex-col gap-2">
      {rows.map((row) => {
        const source = journalSource(row);
        const sourceKey = journalSourceKey(row);
        return (
          <div key={row.id} className="rounded-lg bg-inset px-3 py-2">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1 text-[13px] leading-relaxed text-ink">
                <span>{localizedJournalSummary(row, botName)}</span>
                {" · "}
                <span className="text-ink-secondary">{localizedRelativeTime(row.at, activeLocale(), now)}</span>
                {source && (
                  <>
                    {" · "}
                    <span className="text-ink-secondary">{sourceKey ? t(sourceKey, row.threadTitle ? { title: row.threadTitle } : undefined) : source}</span>
                  </>
                )}
              </div>
              {row.canRevert ? (
                <button
                  type="button"
                  disabled={reverting !== null}
                  onClick={() => onRevert(row)}
                  className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium text-accent-text hover:bg-accent/10 disabled:opacity-50"
                >
                  <RotateCcw size={12} />
                  {reverting === row.id ? t("memory.undoing") : t("memory.undo")}
                </button>
              ) : (
                <span className="shrink-0 text-[12px] text-ink-secondary" title={row.revertUnavailableReason}>
                  {t("memory.cantUndo")}
                </span>
              )}
            </div>
            {row.diff && (
              <details className="mt-1">
                <summary className="cursor-pointer text-[12px] text-ink-secondary">
                  +{row.added} −{row.removed} · {t("memory.showChanged")}
                </summary>
                <pre className="mt-1 max-h-[240px] overflow-auto whitespace-pre-wrap rounded-md bg-card p-2 font-mono text-[12px] leading-relaxed text-ink">
                  {row.diff}
                </pre>
              </details>
            )}
          </div>
        );
      })}
    </div>
  );
}
