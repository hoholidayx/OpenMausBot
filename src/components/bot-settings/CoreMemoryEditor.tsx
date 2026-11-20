import { useEffect, useId, useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
import type { CoreMemoryEdit, CoreMemoryView } from "../../../shared/core-memory";
import { t } from "@/lib/i18n";
import { ApiError } from "@/state/api";
import { SETTINGS_INPUT } from "../SettingsPrimitives";
import { useBotEditor } from "./BotEditorContext";

export function CoreMemoryEditor({ botId }: { botId: string }) {
  const { request } = useBotEditor();
  const id = useId();
  const path = `/api/bots/${botId}/core-memory`;
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<CoreMemoryView>();
  const [old, setOld] = useState<string>();
  const [text, setText] = useState("");
  const [removed, setRemoved] = useState<string>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setError("");
    void request<CoreMemoryView>(path, { signal: controller.signal }).then(data => {
      if (!controller.signal.aborted) setView(data);
    }).catch((cause: Error) => { if (!controller.signal.aborted) setError(cause.message); });
    return () => controller.abort();
  }, [open, path, request, reload]);
  function reset() { setOld(undefined); setText(""); }
  async function change(edit: CoreMemoryEdit) {
    setBusy(true);
    setError("");
    try {
      setView(await request<CoreMemoryView>(path, { method: "POST", body: JSON.stringify(edit) }));
      setRemoved(edit.action === "remove" ? edit.oldText : undefined);
      reset();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409 && cause.body?.current) setView(cause.body.current as CoreMemoryView);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  }
  return <details aria-label={t("coreMemory.title")} className="rounded-xl bg-card p-4 text-ink" onToggle={e => setOpen(e.currentTarget.open)}>
    <summary className="cursor-pointer text-[15px] font-medium">{t("coreMemory.title")}</summary>
    {open && <div className="mt-3 space-y-3">
      {error && <div role="alert" className="flex items-center gap-2 text-[13px] text-danger">{error}
        <button type="button" className="ui-button ui-button-sm" onClick={() => setReload(value => value + 1)}>{t("botMemory.retry")}</button></div>}
      {!view && !error && <p role="status">{t("botOverview.loading")}</p>}
      {view && <>
        <p className="text-[13px] text-ink-secondary" aria-live="polite">{t("coreMemory.capacity", { count: view.entries.length, max: view.maxEntries, bytes: view.bytes, limit: view.maxBytes })}</p>
        {view.entries.length > 0 && <ul className="max-h-80 divide-y divide-hairline/40 overflow-y-auto">
          {view.entries.map((entry, index) => <li key={index} className="flex items-start gap-2 py-1">
            <span dir="auto" className="min-w-0 flex-1 whitespace-pre-wrap break-words py-1 text-[14px]">{entry}</span>
            <button type="button" disabled={busy} className="ui-icon-button touch:size-11" aria-label={t("coreMemory.edit", { entry })}
              onClick={() => { setOld(entry); setText(entry); document.getElementById(id)?.focus(); }}><Pencil size={16} /></button>
            <button type="button" disabled={busy} className="ui-icon-button touch:size-11" aria-label={t("coreMemory.remove", { entry })}
              onClick={() => void change({ action: "remove", oldText: entry })}><Trash2 size={16} /></button>
          </li>)}
        </ul>}
        <form className="space-y-2" onSubmit={e => { e.preventDefault(); void change(old === undefined ? { action: "add", text } : { action: "update", oldText: old, text }); }}>
          <label htmlFor={id} className="block text-[13px]">{t(old === undefined ? "coreMemory.new" : "coreMemory.revise")}</label>
          <input id={id} dir="auto" className={SETTINGS_INPUT} value={text} disabled={busy} onChange={e => setText(e.target.value)} />
          <div className="flex flex-wrap gap-2">
            <button type="submit" className="ui-button ui-button-sm" disabled={busy || !text.trim() || text === old}>{t(old === undefined ? "common.add" : "common.save")}</button>
            {old !== undefined && <button type="button" className="ui-button ui-button-sm" disabled={busy} onClick={reset}>{t("common.cancel")}</button>}
            {removed && <button type="button" className="ui-button ui-button-sm" disabled={busy} onClick={() => void change({ action: "add", text: removed })}>{t("common.undo")}</button>}
          </div>
        </form>
      </>}
    </div>}
  </details>;
}
