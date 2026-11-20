import { useEffect, useRef, useState, type FormEvent } from "react";
import type { BotMemoryStatus } from "../../../shared/bot-memory";
import { t } from "@/lib/i18n";
import type { Bot } from "@/state/store";
import { Switch } from "../SettingsPrimitives";
import { useBotEditor } from "./BotEditorContext";
import { inputCls } from "./field";

const button = "rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover focus-visible:outline-focus disabled:opacity-50";

export function BotMemoryCard({ bot, supported }: { bot: Bot; supported?: boolean }) {
  const { draft } = useBotEditor();
  return draft ? null : <MemorySettings key={bot.id} botId={bot.id} supported={supported} />;
}

function MemorySettings({ botId, supported }: { botId: string; supported?: boolean }) {
  const { request } = useBotEditor();
  const path = `/api/bots/${botId}/long-term-memory`;
  const [status, setStatus] = useState<BotMemoryStatus>();
  const [error, setError] = useState("");
  const [ownerOnly, setOwnerOnly] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const saving = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    request<BotMemoryStatus>(path, { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) setStatus(value);
    }).catch((cause: { status?: number }) => {
      if (controller.signal.aborted) return;
      if (cause.status === 403) setOwnerOnly(true);
      else setError(t("botMemory.readFailed"));
    });
    return () => { controller.abort(); saving.current?.abort(); };
  }, [path, request, refresh]);

  async function save(enabled: boolean, credentials?: { url: string; token: string }) {
    if (saving.current) return;
    const controller = new AbortController();
    saving.current = controller;
    setBusy(true);
    setError("");
    try {
      const value = await request<BotMemoryStatus>(path, { method: "PUT", body: JSON.stringify({ enabled, ...credentials }), signal: controller.signal });
      if (controller.signal.aborted) return;
      setStatus(value);
      setEditing(false);
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
  function configure(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const token = String(data.get("token") ?? "").trim();
    const url = String(data.get("url") ?? "").trim();
    (form.elements.namedItem("token") as HTMLInputElement).value = "";
    void save(true, { token, url });
  }
  const hint = ownerOnly ? t("botMemory.owner") : !status ? error || t("common.checking") : status.failed ? t("botMemory.failed") :
    !status.configured ? t("botMemory.unconfigured") : status.enabled ? t("botMemory.on") : t("botMemory.off");
  return <section aria-label={t("botMemory.title")} className="space-y-3 rounded-xl bg-card p-4 text-ink">
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <h3 className="text-[15px] font-medium">{t("botMemory.title")}</h3>
        <div className="mt-0.5 text-[13px] text-ink-secondary" aria-live="polite">{hint}</div>
      </div>
      <Switch aria-label={t("botMemory.title")} checked={status?.enabled === true} disabled={busy || !status || (!status.enabled && supported === false)}
        onClick={() => status?.configured ? void save(!status.enabled) : setEditing(true)} />
    </div>
    {status && supported === false && <p className="text-[13px] text-ink-secondary">{t("botMemory.engine")}</p>}
    {status && error && <p role="alert" className="text-[13px] text-danger">{error}</p>}
    {!status && error && <button type="button" className={button} onClick={() => setRefresh(value => value + 1)}>{t("botMemory.retry")}</button>}
    {status?.configured && !editing && supported !== false && <button type="button" className={button} onClick={() => setEditing(true)}>{t("botMemory.replace")}</button>}
    {status && editing && <form onSubmit={configure} className="space-y-3">
      <dl className="grid min-w-0 grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px] text-ink-secondary">
        <dt>user_id</dt><dd className="select-all break-all">{status.userId}</dd>
        <dt>agent_id</dt><dd className="select-all break-all">{status.agentId}</dd>
      </dl>
      <label className="block space-y-1 text-[13px]">{t("botMemory.url")}
        <input name="url" type="url" required readOnly={Boolean(status.url)} defaultValue={status.url ?? ""} autoComplete="off" spellCheck={false} className={inputCls} />
      </label>
      <label className="block space-y-1 text-[13px]">{t("botMemory.credential")}
        <input name="token" type="password" required autoComplete="new-password" spellCheck={false} className={inputCls} />
      </label>
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={button} disabled={busy}>{busy ? t("common.checking") : t("botMemory.enable")}</button>
        <button type="button" className={button} disabled={busy} onClick={() => setEditing(false)}>{t("common.cancel")}</button>
      </div>
    </form>}
  </section>;
}
