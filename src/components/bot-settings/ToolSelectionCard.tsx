import { useEffect, useRef, useState } from "react";
import { t } from "@/lib/i18n";
import type { Bot } from "@/state/store";
import { narrowsNativeTools, parseToolScope } from "../../../shared/tool-scope";
import { TOOL_SCOPE_SUPPORT } from "../../../shared/tool-scope-support";
import { useBotEditor } from "./BotEditorContext";
import { inputCls } from "./field";
import { Select } from "../Select";

type Draft = { custom: boolean; onlyListed: boolean; allow: string; deny: string };
type Props = { bot: Bot; engineKind?: string; onSaved?: () => void };
const lines = (text: string) => text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);

/** Direct, acknowledged saves: a rejected restriction must never appear saved in the optimistic queue. */
function useSelectionDraft({ bot, onSaved }: Props) {
  const { request } = useBotEditor();
  const saved = parseToolScope(bot.toolScope);
  const scope = saved.ok ? saved.scope : undefined;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const pending = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const fields = draft ?? {
    custom: bot.toolScope !== undefined, onlyListed: scope?.allow !== undefined,
    allow: scope?.allow?.join("\n") ?? "", deny: scope?.deny?.join("\n") ?? "",
  };
  const proposed = fields.custom ? {
    ...(fields.onlyListed ? { allow: lines(fields.allow) } : {}), deny: lines(fields.deny),
  } : undefined;
  const parsed = parseToolScope(proposed);
  const change = (patch: Partial<Draft>) => { setDraft({ ...fields, ...patch }); setError(null); };
  const save = async () => {
    if (!draft || bot.busy || pending.current || !parsed.ok) return;
    pending.current = true; setSaving(true); setError(null);
    try {
      await request(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ toolScope: parsed.scope ?? null }) });
      if (alive.current) {
        setDraft(null);
        onSaved?.();
      }
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      pending.current = false;
      if (alive.current) setSaving(false);
    }
  };
  const status = !saved.ok ? "botAccess.tools.corrupt" : scope?.allow?.length === 0 ? "botAccess.tools.none"
    : scope === undefined ? "botAccess.tools.all" : "botAccess.tools.customSaved";
  return { saved: saved.ok, status, fields, proposed, parsed, saving, error, draft, change, save } as const;
}

function RuleFields({ fields, locked, engineKind, example, change }: {
  fields: Draft; locked: boolean; engineKind?: string; example: string; change: (patch: Partial<Draft>) => void;
}) {
  return <fieldset disabled={locked} className="mt-3 flex flex-col gap-3">
    <label className="flex items-center gap-2 text-[13px] text-ink">
      <input type="checkbox" checked={fields.onlyListed} onChange={event => change({ onlyListed: event.target.checked })} />
      {t("botAccess.tools.onlyListed")}
    </label>
    <label className="text-[13px] text-ink-secondary">{t("botAccess.tools.allow")}
      <textarea aria-label={t("botAccess.tools.allow")} disabled={!fields.onlyListed} rows={3} spellCheck={false}
        className={`${inputCls} mt-1 font-mono text-[12px] disabled:opacity-50`} placeholder={example} value={fields.allow} onChange={event => change({ allow: event.target.value })} />
    </label>
    {fields.onlyListed && lines(fields.allow).length === 0 && <p className="text-[12px] text-ink-secondary">{t("botAccess.tools.emptyHint")}</p>}
    <label className="text-[13px] text-ink-secondary">{t("botAccess.tools.exclude")}
      <textarea aria-label={t("botAccess.tools.exclude")} rows={2} spellCheck={false} className={`${inputCls} mt-1 font-mono text-[12px]`}
        placeholder="mcp:mail:send" value={fields.deny} onChange={event => change({ deny: event.target.value })} />
    </label>
    <p className="text-[12px] text-ink-secondary">{t("botAccess.tools.syntax")}</p>
    {engineKind === "grokAgent" && <p className="text-[12px] text-ink-secondary">{t("botAccess.tools.grok")}</p>}
  </fieldset>;
}

function selectionHelp(engineKind: string | undefined, fields: Draft, proposed: ReturnType<typeof useSelectionDraft>["proposed"]) {
  const support = TOOL_SCOPE_SUPPORT[engineKind as keyof typeof TOOL_SCOPE_SUPPORT];
  const restricted = fields.custom && (fields.onlyListed || lines(fields.deny).length > 0);
  const unavailable = restricted && support !== "native-and-mcp" && (support !== "mcp" || narrowsNativeTools(proposed));
  const example = engineKind === "piAgent" ? "native:read\nnative:edit\nnative:write"
    : engineKind === "grokAgent" ? "native:read_file\nnative:search_replace\nnative:write"
      : support === "mcp" ? "native:*\nmcp:mail:read_notes" : "native:ask_user\nmcp:mail:read_notes";
  return { example, warning: unavailable ? t(support === "mcp" ? "botAccess.tools.nativeUnsupported" : "botAccess.tools.unsupported") : null };
}

export function ToolSelectionCard(props: Props) {
  const { bot, engineKind, onSaved } = props;
  const { saved, status, fields, proposed, parsed, saving, error, draft, change, save } = useSelectionDraft(props);
  const { example, warning } = selectionHelp(engineKind, fields, proposed);
  const locked = saving || Boolean(bot.busy);
  return <div className="rounded-xl bg-card p-4">
    {!onSaved && <div className="text-[15px] font-medium text-ink">{t("botAccess.tools.title")}</div>}
    <p className="mt-0.5 text-[13px] text-ink-secondary">{t("botAccess.tools.description")}</p>
    <p role={saved ? "status" : "alert"} className={`mt-2 text-[12px] ${saved ? "text-ink-secondary" : "text-danger"}`}>
      {t(status)}
    </p>
    <label className="mt-3 block text-[13px] text-ink-secondary">
      {t("botAccess.tools.mode")}
      <Select aria-label={t("botAccess.tools.title")} disabled={locked} value={fields.custom ? "custom" : "all"}
        className="mt-1 w-full" onChange={event => change({ custom: event.target.value === "custom", onlyListed: fields.custom ? fields.onlyListed : true })}>
        <option value="all">{t("botAccess.tools.all")}</option>
        <option value="custom">{t("botAccess.tools.custom")}</option>
      </Select>
    </label>
    {fields.custom && <RuleFields fields={fields} locked={locked} engineKind={engineKind} example={example} change={change} />}
    {warning && <p role="alert" className="mt-2 text-[12px] text-danger">{warning}</p>}
    {!parsed.ok && <p role="alert" className="mt-2 text-[12px] text-danger">{parsed.error}</p>}
    {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
    {bot.busy && <p className="mt-2 text-[12px] text-ink-secondary">{t("botAccess.tools.busy")}</p>}
    <div className="mt-3 flex flex-wrap items-center gap-3">
      <button type="button" disabled={locked || !draft || !parsed.ok} onClick={() => void save()}
        className="ui-button ui-button-md ui-button-pill ui-button-primary touch:min-h-11">
        {t(saving ? "botAccess.tools.saving" : "botAccess.tools.save")}
      </button>
      <a href="https://github.com/milind-soni/OpenMausBot/blob/main/docs/tool-selection.md" target="_blank" rel="noreferrer" className="text-[12px] text-ink-secondary underline">{t("botAccess.tools.examples")}</a>
    </div>
  </div>;
}
