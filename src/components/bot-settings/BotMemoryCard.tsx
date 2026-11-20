import { useEffect, useRef, useState } from "react";
import type { BotMemoryStatus } from "../../../shared/bot-memory";
import { t } from "@/lib/i18n";
import type { Bot } from "@/state/store";
import { Switch } from "../SettingsPrimitives";
import { useBotEditor } from "./BotEditorContext";
import { Mem0ConnectionForm } from "../Mem0Connection";

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

  async function toggle(enabled: boolean, configured = status?.configured) {
    if (saving.current) return;
    const controller = new AbortController();
    saving.current = controller;
    setBusy(true);
    setError("");
    try {
      if (enabled && !configured) {
        const latest = await request<BotMemoryStatus>(path, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setStatus(latest);
        if (!latest.configured) { setEditing(true); return; }
      }
      const value = await request<BotMemoryStatus>(path, { method: "PUT", body: JSON.stringify({ enabled }), signal: controller.signal });
      if (!controller.signal.aborted) setStatus(value);
    } catch (cause) {
      if (!controller.signal.aborted) setError((cause as Error).message || t("botMemory.connectFailed"));
    } finally {
      saving.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  const hint = ownerOnly ? t("botMemory.owner") : !status ? error || t("common.checking") : status.failed ? t("botMemory.failed") :
    !status.configured ? t("botMemory.unconfigured") : status.enabled ? t("botMemory.on") : t("botMemory.off");
  return <section aria-label={t("botMemory.title")} className="space-y-3 rounded-xl bg-card p-4 text-ink">
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <h3 className="text-[15px] font-medium">{t("botMemory.title")}</h3>
        <div className="mt-0.5 text-[13px] text-ink-secondary" aria-live="polite">{hint}</div>
      </div>
      <Switch aria-label={t("botMemory.title")} checked={status?.enabled === true} disabled={busy || editing || !status || (!status.enabled && supported === false)}
        onClick={() => void toggle(!status?.enabled)} />
    </div>
    {status && supported === false && <p className="text-[13px] text-ink-secondary">{t("botMemory.engine")}</p>}
    {status && error && <p role="alert" className="text-[13px] text-danger">{error}</p>}
    {!status && error && <button type="button" className="ui-button" onClick={() => setRefresh(value => value + 1)}>{t("botMemory.retry")}</button>}
    {status && editing && <Mem0ConnectionForm url={status.url} firstBot cancel={() => setEditing(false)} saved={connection => {
      setStatus({ ...status, ...connection });
      setEditing(false);
      void toggle(true, true);
    }} />}
  </section>;
}
