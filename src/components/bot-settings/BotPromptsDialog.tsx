import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { X } from "lucide-react";
import type { BotModelPrefixSetting, BotPromptSetting } from "../../../shared/bot-prompts";
import { BOT_PROFILE_LIMITS } from "../../../shared/bot-profile";
import { useModalDialog } from "@/hooks/use-modal-dialog";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { utf8Bytes } from "@/lib/soul";
import { api, useStore, type Bot } from "@/state/store";
import { Layer } from "../Layer";
import { SETTINGS_INPUT } from "../SettingsPrimitives";
import { PrefixModeSelect, type PrefixMode } from "./BotModelPrefix";
import type { PromptPreviewData } from "./PromptPreview";

type Field = BotPromptSetting | BotModelPrefixSetting;
type Catalog = PromptPreviewData & { editable: BotPromptSetting[]; modelPrefix: BotModelPrefixSetting | null };
type Draft = { base: Field; value: string | null; mode?: PrefixMode; customText?: string };
type DialogProps = { bot: Bot; onClose: () => void; initialPrefix?: boolean; threadId?: string };
const prefixId = "model-system-prefix";
const fieldName = (id: Field["id"]) => id === prefixId ? t("settings.modelSystemPrefix.title") : t(`botPrompts.${id}`);
const editableFields = (catalog: Catalog) => catalog.modelPrefix ? [catalog.modelPrefix, ...catalog.editable] : catalog.editable;
const count = (bytes: number) => t("botPrompts.tokens", { tokens: Math.ceil(bytes / 4) });

export function BotPromptsDialog(props: DialogProps) {
  return <Layer modal><Editor key={props.bot.id} {...props} /></Layer>;
}

function Editor({ bot, onClose, initialPrefix, threadId }: DialogProps) {
  const dialog = useRef<HTMLDivElement>(null);
  const title = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  useModalDialog(dialog, onClose);
  const { flushBotPatches } = useStore();
  const query = new URLSearchParams({ editor: "1" });
  if (threadId) query.set("threadId", threadId);
  const path = `/api/bots/${bot.id}/system-prompt?${query}`;
  const [catalog, setCatalog] = useState<Catalog>();
  const [reload, setReload] = useState(0);
  const [selection, setSelection] = useState(initialPrefix ? prefixId : "soul");
  const [drafts, setDrafts] = useState<Partial<Record<Field["id"], Draft>>>({});
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    setError("");
    setCatalog(undefined);
    void flushBotPatches(bot.id, { threadId }).then(() => api<Catalog>(path)).then((data) => {
      if (!Array.isArray(data.editable)) throw new Error(t("botOverview.promptError"));
      if (active) {
        setCatalog(data);
        if (!data.modelPrefix) setSelection((id) => id === prefixId ? "soul" : id);
      }
    }).catch((e: Error) => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [bot.id, flushBotPatches, path, reload, threadId]);

  const fields = catalog ? editableFields(catalog) : [];
  const field = fields.find(({ id }) => id === selection);
  const section = catalog?.sections.find(({ id }) => `preview/${id}` === selection);
  const draft = field && drafts[field.id];
  const save = async () => {
    if (!draft || saving) return;
    const { base } = draft;
    dialog.current?.focus();
    setSaving(true);
    setError("");
    try {
      const data = await api<Catalog>(path, { method: "PUT", body: JSON.stringify({
        id: base.id, expected: base.override, defaultText: base.defaultText, value: draft.value,
        ...(base.id === prefixId ? { instanceId: base.instanceId, model: base.model } : {}),
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
          <PromptPicker catalog={catalog} fields={fields} selection={selection} saving={saving} choose={choose} />
          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
            {field && <PromptTextEditor field={field} draft={drafts[field.id]} input={input} saving={saving}
              update={(next) => setDrafts({ ...drafts, [field.id]: next })} save={save} />}
            {section && <>
              <h3 className="text-[17px] font-semibold">{section.id === prefixId ? fieldName(prefixId) : section.label}</h3>
              <pre tabIndex={0} aria-label={section.label} dir="auto" className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-inset p-3 text-[13px] leading-relaxed focus-visible:outline-focus">{section.text}</pre>
              <p className="text-[12px] text-ink-secondary">{t("botPrompts.previewHint")}</p>
            </>}
          </div>
        </div>}
      </div>
    </div>
  );
}

function PromptTextEditor({ field, draft, input, saving, update, save }: {
  field: Field; draft?: Draft; input: RefObject<HTMLTextAreaElement | null>; saving: boolean;
  update: (draft: Draft) => void; save: () => Promise<void>;
}) {
  const id = useId();
  const base = draft?.base ?? field;
  const override = draft ? draft.value : field.override;
  const value = override ?? base.defaultText;
  const bytes = utf8Bytes(value);
  const prefix = base.id === prefixId ? base : undefined;
  const mode = draft?.mode ?? modeForOverride(override);
  const readOnly = Boolean(prefix && mode !== "custom");
  const invalid = bytes > BOT_PROFILE_LIMITS.soul || Boolean(prefix && mode === "custom" && !value.trim());
  const edit = (next: string | null, mode?: PrefixMode) => {
    const customText = mode === "custom" ? next ?? "" : draft?.customText;
    update({ base, value: next, mode, customText });
  };
  return <>
    <div className="flex items-baseline justify-between gap-2">
      <label htmlFor={id} className="text-[17px] font-semibold">{fieldName(field.id)}</label>
      {!prefix && <span className="text-[12px] text-ink-secondary">{t(override == null ? "botPrompts.default" : "botPrompts.custom")}</span>}
    </div>
    {prefix && <PrefixModeSelect setting={prefix} mode={mode} disabled={saving} onChange={(next) => {
      const custom = draft?.customText ?? (prefix.override || prefix.defaultText);
      edit(next === "inherit" ? null : next === "off" ? "" : custom, next);
    }} />}
    <textarea key={field.id} ref={input} id={id} dir="auto" value={value} disabled={saving} readOnly={readOnly}
      placeholder={readOnly ? t("botPrompts.prefixEmpty") : undefined}
      onChange={(e) => edit(e.target.value, prefix ? "custom" : undefined)}
      aria-invalid={invalid}
      className={`${SETTINGS_INPUT} min-h-0 flex-1 resize-none p-3 font-mono leading-relaxed`} />
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-[12px] tabular-nums text-ink-secondary">
        {t("botIdentity.soul.bytes", { bytes, limit: BOT_PROFILE_LIMITS.soul })} · {count(bytes)}
      </span>
      <div className="flex gap-2">
        <button type="button" className="ui-button ui-button-sm ui-button-pill" disabled={saving || override == null}
          onClick={() => { edit(null); input.current?.scrollTo({ top: 0 }); }}>{t("botPrompts.restore")}</button>
        <button type="button" className="ui-button ui-button-sm ui-button-primary ui-button-pill"
          disabled={saving || override === field.override || invalid}
          onClick={() => void save()}>{t(saving ? "common.saving" : "common.save")}</button>
      </div>
    </div>
  </>;
}

function modeForOverride(override: string | null): PrefixMode {
  if (override === null) return "inherit";
  return override === "" ? "off" : "custom";
}

function PromptPicker({ catalog, fields, selection, saving, choose }: {
  catalog: Catalog; fields: Field[]; selection: string; saving: boolean; choose: (id: string) => void;
}) {
  const groups = [
    { label: t("botPrompts.editable"), rows: fields.map(({ id }) => ({ id, label: fieldName(id), tokens: "" })) },
    { label: t("botPrompts.preview"), rows: catalog.sections.map((part) => ({
      id: `preview/${part.id}`, label: part.id === prefixId ? fieldName(prefixId) : part.label, tokens: count(part.bytes),
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
