import { useDeferredValue, useId, useRef, useState, type CSSProperties } from "react";
import { ArrowLeft, Search, X } from "lucide-react";
import { useModalDialog } from "@/hooks/use-modal-dialog";
import { t } from "@/lib/i18n";
import type { Bot } from "@/state/store";
import { Layer } from "../Layer";
import { SETTINGS_INPUT } from "../SettingsPrimitives";
import { Segmented } from "../bot-panel/rows";
import { BotToolList, type ToolFilter } from "./BotToolList";
import { ToolSelectionCard } from "./ToolSelectionCard";
import { useBotToolCatalog } from "./useBotToolCatalog";
import type { BotPatch } from "./useBotSettingsDerived";

type Props = { bot: Bot; engineKind?: string; patch: (patch: BotPatch) => void; onClose: () => void };
const noDrag = { WebkitAppRegion: "no-drag" } as CSSProperties;

export function BotToolsDialog(props: Props) {
  return <Layer modal><BotToolsContent {...props} /></Layer>;
}

function BotToolsContent({ bot, engineKind, patch, onClose }: Props) {
  const title = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const rulesButton = useRef<HTMLButtonElement>(null);
  const rulesBack = useRef<HTMLButtonElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const [rules, setRules] = useState(false);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [filter, setFilter] = useState<ToolFilter>("all");
  const directory = useBotToolCatalog(bot);
  const back = () => {
    setRules(false);
    requestAnimationFrame(() => {
      const target = trigger.current;
      (target?.isConnected ? target : rulesButton.current)?.focus({ preventScroll: true });
    });
  };
  const openRules = (from: HTMLElement) => {
    trigger.current = from;
    setRules(true);
    requestAnimationFrame(() => rulesBack.current?.focus());
  };
  useModalDialog(dialog, rules ? back : onClose);

  return (
    <div data-thread-overlay className="ui-scrim fixed inset-0 z-[90] flex items-center justify-center motion-reduce:animate-none sm:p-5"
      style={noDrag} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={title} data-bot-tools-dialog
        className="ui-modal flex h-dvh w-full max-w-[900px] flex-col overflow-hidden outline-none max-sm:rounded-none max-sm:border-0 max-sm:pt-[env(safe-area-inset-top)] max-sm:pb-[env(safe-area-inset-bottom)] sm:h-[min(760px,90dvh)]">
        <header className="flex shrink-0 items-center gap-2 px-4 pt-3 pb-2 sm:px-5 sm:pt-4">
          {rules && <button ref={rulesBack} type="button" className="ui-icon-button shrink-0 max-sm:size-11 touch:size-11"
            aria-label={t("botTools.back")} onClick={back}><ArrowLeft size={16} className="rtl:-scale-x-100" aria-hidden="true" /></button>}
          <div className="min-w-0 flex-1">
            <h2 id={title} className="truncate text-xl font-semibold tracking-[-0.01em]">{t(rules ? "botTools.rules" : "botAccess.toolGroups.title")}</h2>
            <p className="truncate text-[13px] text-ink-secondary" title={bot.name} dir="auto">{bot.name}</p>
          </div>
          {!rules && <button ref={rulesButton} type="button" className="ui-button ui-button-sm ui-button-pill shrink-0 max-sm:min-h-11 touch:min-h-11"
            onClick={(event) => openRules(event.currentTarget)}>{t("botTools.rules")}</button>}
          <button type="button" className="ui-icon-button shrink-0 max-sm:size-11 touch:size-11" aria-label={t("common.close")}
            onClick={onClose}><X size={16} aria-hidden="true" /></button>
        </header>
        {rules && (
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 sm:px-5">
            <ToolSelectionCard bot={bot} engineKind={engineKind} onSaved={back} />
          </div>
        )}
        <div className="flex min-h-0 flex-1 flex-col" hidden={rules}>
          <div className="grid shrink-0 gap-2 px-4 pb-3 sm:grid-cols-2 sm:px-5">
            <div className="relative">
              <Search size={14} aria-hidden="true" className="pointer-events-none absolute start-2.5 top-1/2 -translate-y-1/2 text-ink-secondary" />
              <input type="search" className={`${SETTINGS_INPUT} ps-8 max-sm:h-11 max-sm:text-base touch:h-11 touch:text-base`} dir="auto"
                aria-label={t("botTools.search")} placeholder={t("botTools.search")} value={query} onChange={(event) => {
                  setQuery(event.target.value);
                  if (scroll.current) scroll.current.scrollTop = 0;
                }} />
            </div>
            <div className="min-w-0 max-sm:[&_button]:min-h-11 touch:[&_button]:min-h-11">
              <Segmented attr="data-tool-filter" label={t("botTools.filter.label")} value={filter}
                options={[
                  { value: "all", label: t("botTools.filter.all") },
                  { value: "mounted", label: t("botTools.filter.mounted") },
                  { value: "unmounted", label: t("botTools.filter.unmounted") },
                ]} onChange={(next) => {
                  setFilter(next);
                  if (scroll.current) scroll.current.scrollTop = 0;
                }} />
            </div>
          </div>
          {directory.error && <CatalogError label={t("botTools.loadError")} onRetry={directory.retry} />}
          {directory.appsError && <CatalogError label={t("botTools.appsError")} onRetry={directory.retryApps} />}
          {!directory.error && !directory.catalog && <p role="status" className="px-4 py-2 text-[13px] text-ink-secondary sm:px-5">{t("botTools.loading")}</p>}
          {directory.catalog?.apps && !directory.apps && !directory.appsError && <p role="status" className="px-4 pb-2 text-[12px] text-ink-secondary sm:px-5">{t("botTools.loadingApps")}</p>}
          <div ref={scroll} role="region" aria-label={t("botAccess.toolGroups.title")}
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1 pb-3 sm:px-2">
            <BotToolList bot={bot} engineKind={engineKind} directory={directory}
              filter={filter} query={deferredQuery} patch={patch} scroll={scroll} onRules={openRules} />
          </div>
        </div>
      </div>
    </div>
  );
}

function CatalogError({ label, onRetry }: { label: string; onRetry: () => void }) {
  return <div className="flex shrink-0 flex-wrap items-center gap-2 px-4 pb-2 text-[13px] sm:px-5">
    <p role="alert" className="text-danger">{label}</p>
    <button type="button" className="ui-button ui-button-sm ui-button-pill touch:min-h-11" onClick={onRetry}>{t("connectors.action.retry")}</button>
  </div>;
}
