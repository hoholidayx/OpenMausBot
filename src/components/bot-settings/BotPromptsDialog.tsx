import { useEffect, useId, useRef, useState } from "react";
import { X } from "lucide-react";
import type { BotPromptField, BotPromptSetting } from "../../../shared/bot-prompts";
import { BOT_PROFILE_LIMITS } from "../../../shared/bot-profile";
import { useModalDialog } from "@/hooks/use-modal-dialog";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { utf8Bytes } from "@/lib/soul";
import { api, useStore, type Bot } from "@/state/store";
import { Layer } from "../Layer";
import { SETTINGS_INPUT } from "../SettingsPrimitives";
import type { PromptPreviewData } from "./PromptPreview";

type Catalog = PromptPreviewData & { editable: BotPromptSetting[] };
type Draft = { base: BotPromptSetting; value: string | null };
const fieldName = (id: BotPromptField) => t(`botPrompts.${id}`);
const count = (bytes: number) => t("botPrompts.tokens", { tokens: Math.ceil(bytes / 4) });

export function BotPromptsDialog(props: { bot: Bot; onClose: () => void }) {
  return <Layer modal><Editor key={props.bot.id} {...props} /></Layer>;
}

function Editor({ bot, onClose }: { bot: Bot; onClose: () => void }) {
  const dialog = useRef<HTMLDivElement>(null);
  const title = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  useModalDialog(dialog, onClose);
  const { flushBotPatches } = useStore();
  const path = `/api/bots/${bot.id}/system-prompt`;
  const [catalog, setCatalog] = useState<Catalog>();
  const [reload, setReload] = useState(0);
  const [selection, setSelection] = useState("soul");
  const [drafts, setDrafts] = useState<Partial<Record<BotPromptField, Draft>>>({});
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    setError("");
    setCatalog(undefined);
    void flushBotPatches(bot.id).then(() => api<Catalog>(`${path}?editor=1`)).then((data) => {
      if (!Array.isArray(data.editable)) throw new Error(t("botOverview.promptError"));
      if (active) setCatalog(data);
    }).catch((e: Error) => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [bot.id, flushBotPatches, path, reload]);

  const field = catalog?.editable.find(({ id }) => id === selection);
  const section = catalog?.sections.find(({ id }) => `preview/${id}` === selection);
  const draft = field && drafts[field.id];
  const override = draft ? draft.value : field?.override;
  const value = override ?? field?.defaultText ?? "";
  const bytes = utf8Bytes(value);
  const edit = (next: string | null) => {
    if (field) setDrafts({ ...drafts, [field.id]: { base: draft?.base ?? field, value: next } });
  };
  const save = async () => {
    if (!draft || saving) return;
    const { base } = draft;
    dialog.current?.focus();
    setSaving(true);
    setError("");
    try {
      const data = await api<Catalog>(path, { method: "PUT", body: JSON.stringify({
        id: base.id, expected: base.override, defaultText: base.defaultText, value: draft.value,
      }) });
      setCatalog(data);
      setDrafts((current) => ({ ...current, [base.id]: undefined }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
      requestAnimationFrame(() => input.current?.focus());
    }
  };

  const choose = (id: string) => {
    setSelection(id);
    setError("");
  };
  return (
    <div data-thread-overlay className="ui-scrim fixed inset-0 z-[90] flex items-center justify-center sm:p-5"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={title} data-bot-prompts-dialog
        className="ui-modal flex h-dvh w-full max-w-[900px] flex-col gap-4 overflow-hidden p-4 outline-none max-sm:rounded-none max-sm:pt-[max(1rem,env(safe-area-inset-top))] max-sm:pb-[max(1rem,env(safe-area-inset-bottom))] sm:h-[min(760px,90dvh)] sm:p-5">
        <header className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 id={title} className="truncate text-xl font-semibold">{t("botPrompts.title")}</h2>
            <p className="truncate text-[13px] text-ink-secondary" dir="auto">{bot.name}</p>
          </div>
          <button type="button" className="ui-icon-button shrink-0 touch:size-11" aria-label={t("common.close")} onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        {error && <div role="alert" className="flex items-center gap-3 text-[13px] text-danger">
          <span>{error}</span>
          <button type="button" className="ui-button ui-button-sm" onClick={() => {
            if (field) setDrafts({ ...drafts, [field.id]: undefined });
            setReload(reload + 1);
          }}>{t("botPrompts.reload")}</button>
        </div>}
        {!catalog && !error && <p role="status">{t("botOverview.loading")}</p>}
        {catalog && <div className="flex min-h-0 flex-1 flex-col gap-4 sm:flex-row">
          <PromptPicker catalog={catalog} selection={selection} saving={saving} choose={choose} />
          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
            {field && <>
              <div className="flex items-baseline justify-between gap-2">
                <label htmlFor={`${title}-text`} className="text-[17px] font-semibold">{fieldName(field.id)}</label>
                <span className="text-[12px] text-ink-secondary">{t(override == null ? "botPrompts.default" : "botPrompts.custom")}</span>
              </div>
              <textarea key={field.id} ref={input} id={`${title}-text`} dir="auto" value={value} disabled={saving} onChange={(e) => edit(e.target.value)}
                aria-invalid={bytes > BOT_PROFILE_LIMITS.soul}
                className={`${SETTINGS_INPUT} min-h-0 flex-1 resize-none p-3 font-mono leading-relaxed`} />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[12px] tabular-nums text-ink-secondary">
                  {t("botIdentity.soul.bytes", { bytes, limit: BOT_PROFILE_LIMITS.soul })} · {count(bytes)}
                </span>
                <div className="flex gap-2">
                  <button type="button" className="ui-button ui-button-sm ui-button-pill" disabled={saving || override == null}
                    onClick={() => { edit(null); input.current?.scrollTo({ top: 0 }); }}>{t("botPrompts.restore")}</button>
                  <button type="button" className="ui-button ui-button-sm ui-button-primary ui-button-pill"
                    disabled={saving || override === field.override || bytes > BOT_PROFILE_LIMITS.soul}
                    onClick={() => void save()}>{t(saving ? "common.saving" : "common.save")}</button>
                </div>
              </div>
            </>}
            {section && <>
              <h3 className="text-[17px] font-semibold">{section.label}</h3>
              <pre tabIndex={0} aria-label={section.label} dir="auto" className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-inset p-3 text-[13px] leading-relaxed focus-visible:outline-focus">{section.text}</pre>
              <p className="text-[12px] text-ink-secondary">{t("botPrompts.previewHint")}</p>
            </>}
          </div>
        </div>}
      </div>
    </div>
  );
}

function PromptPicker({ catalog, selection, saving, choose }: {
  catalog: Catalog; selection: string; saving: boolean; choose: (id: string) => void;
}) {
  const groups = [
    { label: t("botPrompts.editable"), rows: catalog.editable.map(({ id }) => ({ id, label: fieldName(id), tokens: "" })) },
    { label: t("botPrompts.preview"), rows: catalog.sections.map((part) => ({
      id: `preview/${part.id}`, label: part.label, tokens: count(part.bytes),
    })) },
  ];

  return <>
    <nav aria-label={t("botPrompts.section")} className="hidden w-56 shrink-0 overflow-y-auto pe-2 sm:block">
      {groups.map((group) => <div key={group.label} className="mb-4">
        <h3 className="mb-1 px-2 text-[12px] font-medium text-ink-secondary">{group.label}</h3>
        {group.rows.map((row) => <button key={row.id} type="button" disabled={saving} aria-current={selection === row.id}
          className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-[13px] hover:bg-raised",
            selection === row.id ? "bg-raised font-medium text-ink" : "text-ink-secondary")}
          onClick={() => choose(row.id)} title={row.label}>
          <span className="min-w-0 flex-1 truncate">{row.label}</span>
          {row.tokens && <span className="text-[12px] tabular-nums text-ink-tertiary">{row.tokens}</span>}
        </button>)}
      </div>)}
    </nav>
    <select className={`${SETTINGS_INPUT} shrink-0 sm:hidden`} aria-label={t("botPrompts.section")} value={selection} disabled={saving}
      onChange={(e) => choose(e.target.value)}>
      {groups.map((group) => <optgroup key={group.label} label={group.label}>
        {group.rows.map((row) => <option key={row.id} value={row.id}>{row.label}{row.tokens && ` · ${row.tokens}`}</option>)}
      </optgroup>)}
    </select>
  </>;
}
