import { useEffect, useRef, useState, type FormEvent } from "react";
import { MEMORY_CONNECTION_PATH, type MemoryConnectionStatus } from "../../shared/bot-memory";
import { t } from "@/lib/i18n";
import { api } from "@/state/store";
import { inputCls } from "./bot-settings/field";

type FormProps = {
  url?: string;
  firstBot?: boolean;
  saved: (status: MemoryConnectionStatus) => void;
  cancel: () => void;
};

export function Mem0ConnectionForm({ url, firstBot, saved, cancel }: FormProps) {
  const saving = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => () => saving.current?.abort(), []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving.current) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const body = JSON.stringify({ url: String(data.get("url")).trim(), token: String(data.get("token")).trim() });
    (form.elements.namedItem("token") as HTMLInputElement).value = "";
    const controller = new AbortController();
    saving.current = controller;
    setBusy(true);
    setError("");
    try {
      const status = await api<MemoryConnectionStatus>(MEMORY_CONNECTION_PATH, { method: firstBot ? "POST" : "PUT", body, signal: controller.signal });
      if (!controller.signal.aborted) saved(status);
    } catch (cause) {
      if (controller.signal.aborted) return;
      const http = (cause as { status?: number }).status;
      setError(http === 422 ? t("botMemory.roleFailed") : http === 409 ? (cause as Error).message :
        http === 403 ? t("botMemory.owner") : http === 400 ? t("botMemory.invalid") : t("botMemory.connectFailed"));
    } finally {
      saving.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return <form onSubmit={submit} className="space-y-3">
    <p className="text-[13px] text-ink-secondary">{t("botMemory.setup")}</p>
    <label className="block space-y-1 text-[13px]">{t("botMemory.url")}
      <input name="url" type="url" required defaultValue={url ?? ""} autoComplete="off" spellCheck={false} className={inputCls} />
    </label>
    <label className="block space-y-1 text-[13px]">{t("botMemory.credential")}
      <input name="token" type="password" required autoComplete="new-password" spellCheck={false} className={inputCls} />
    </label>
    {error && <p role="alert" className="text-[13px] text-danger">{error}</p>}
    <div className="flex flex-wrap gap-2">
      <button type="submit" className="ui-button ui-button-primary" disabled={busy}>{busy ? t("common.checking") : firstBot ? t("botMemory.enable") : t("common.save")}</button>
      <button type="button" className="ui-button" disabled={busy} onClick={cancel}>{t("common.cancel")}</button>
    </div>
  </form>;
}

export function Mem0Connection() {
  const [status, setStatus] = useState<MemoryConnectionStatus>();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    api<MemoryConnectionStatus>(MEMORY_CONNECTION_PATH, { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) setStatus(value);
    }).catch((cause: { status?: number }) => {
      if (!controller.signal.aborted && cause.status !== 403) setError(t("botMemory.readFailed"));
    });
    return () => controller.abort();
  }, [refresh]);
  if (!status && !error) return null;
  return <section aria-label="Mem0" className="mb-4 space-y-3 rounded-xl bg-card p-4 text-ink">
    <div className="flex flex-wrap items-center gap-3">
      <div className="min-w-0 flex-1">
        <h3 className="text-[15px] font-medium">Mem0</h3>
        <p className="break-all text-[13px] text-ink-secondary">{error || (status?.configured ? status.url : t("botMemory.unconfigured"))}</p>
      </div>
      {error ? <button type="button" className="ui-button" onClick={() => setRefresh(value => value + 1)}>{t("botMemory.retry")}</button> :
        !editing && <button type="button" className="ui-button" onClick={() => setEditing(true)}>{status?.configured ? t("botMemory.replace") : t("botMemory.connect")}</button>}
    </div>
    {editing && <Mem0ConnectionForm url={status?.url} cancel={() => setEditing(false)} saved={value => { setStatus(value); setEditing(false); }} />}
  </section>;
}
