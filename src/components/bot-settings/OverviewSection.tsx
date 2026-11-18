import { useState } from "react";
import { ChevronRight } from "lucide-react";

import type { BotOverview } from "@/lib/bot-overview-types";
import { t } from "@/lib/i18n";
import { whenLabel } from "@/lib/schedule-label";
import { overviewLineText, overviewRoutineText, recentChangeText } from "@/lib/bot-overview-text";
import type { BotSettingsSection } from "@/state/store";
import { PromptPreview, type PromptPreviewData } from "./PromptPreview";

export function OverviewSection({
  overview,
  refreshError,
  prompt,
  promptError,
  onOpen,
  onOpenPrompts,
}: {
  overview: BotOverview | null;
  onOpenPrompts?: () => void;
  refreshError?: boolean;
  prompt: PromptPreviewData | null;
  promptError?: boolean;
  onOpen: (section: BotSettingsSection) => void;
}) {
  const [promptOpen, setPromptOpen] = useState(false);

  if (!overview) {
    return <div className="text-[13px] text-ink-secondary">{t("botOverview.loading")}</div>;
  }

  return (
    <div className="flex flex-col gap-4">
      {refreshError && (
        <div className="rounded-lg bg-inset px-3 py-2 text-[13px] text-ink-secondary">
          {t("botOverview.refreshError")}
        </div>
      )}

      <div className="rounded-xl bg-card p-4">
        <div className="text-[15px] font-medium text-ink">{overview.who.name}</div>
        {overview.who.title && <div className="mt-0.5 text-[13px] text-ink-secondary">{overview.who.title}</div>}
        {overview.who.blurb && <p className="mt-2 text-[13px] leading-relaxed text-ink">{overview.who.blurb}</p>}
        {overview.who.soulLead && (
          <div className="mt-3 rounded-lg bg-inset px-3 py-2.5">
            <p className="text-[13px] leading-relaxed text-ink-secondary">{overview.who.soulLead}</p>
            <button
              type="button"
              onClick={() => onOpen("soul")}
              className="mt-1.5 rounded-md text-[12px] font-medium text-accent-text hover:underline"
            >
              {t("botOverview.readAll")}
            </button>
          </div>
        )}
      </div>

      <div className="rounded-xl bg-card p-4">
        <div className="text-[15px] font-medium text-ink">{t("botOverview.does")}</div>
        {overview.does.length === 0 ? (
          <p className="mt-2 text-[13px] text-ink-secondary">{t("botOverview.doesEmpty")}</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1.5 text-[13px] leading-relaxed text-ink">
            {overview.does.map((line, i) => (
              <li key={i}>{overviewRoutineText(overview.doesRoutines?.[i]) ?? overviewLineText(line)}</li>
            ))}
          </ul>
        )}
      </div>

      <div className="rounded-xl bg-card p-4">
        <div className="text-[15px] font-medium text-ink">{t("botOverview.canReach")}</div>
        {overview.reaches.length === 0 ? (
          <p className="mt-2 text-[13px] text-ink-secondary">{t("botOverview.reachEmpty")}</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1.5 text-[13px] leading-relaxed text-ink">
            {overview.reaches.map((line, i) => (
              <li key={i}>{overviewLineText(line, overview.managedSections)}</li>
            ))}
          </ul>
        )}
      </div>

      <div className="rounded-xl bg-card p-4">
        <div className="text-[15px] font-medium text-ink">{t("botOverview.wont")}</div>
        <ul className="mt-2 flex flex-col gap-1.5 text-[13px] leading-relaxed text-ink">
          {overview.wont.map((line, i) => (
            <li key={i}>{overviewLineText(line, overview.managedSections)}</li>
          ))}
        </ul>
      </div>

      {onOpenPrompts && <button type="button" aria-haspopup="dialog" className="ui-button ui-button-sm ui-button-pill self-start" onClick={onOpenPrompts}>{t("botPrompts.title")}</button>}
      <PromptPreview
        data={prompt}
        error={promptError}
        open={promptOpen}
        onToggle={() => setPromptOpen((current) => !current)}
      />

      <div className="rounded-xl bg-card p-4">
        <div className="flex items-baseline justify-between gap-3">
          <div className="text-[15px] font-medium text-ink">{t("botOverview.recentChanges")}</div>
          <button
            type="button"
            onClick={() => onOpen("history")}
            className="shrink-0 text-[12px] text-ink-secondary hover:text-ink"
          >
            {t("botOverview.viewAll")} <ChevronRight size={14} aria-hidden="true" className="inline align-[-2px] rtl:-scale-x-100" />
          </button>
        </div>
        {overview.recent.length === 0 ? (
          <p className="mt-2 text-[13px] text-ink-secondary">{t("botOverview.recentEmpty")}</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1.5 text-[13px] text-ink">
            {overview.recent.map((entry, i) => (
              <li key={i} className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate">{recentChangeText(entry.summary)}</span>
                <span className="shrink-0 text-[12px] text-ink-secondary">· {whenLabel(entry.at)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
