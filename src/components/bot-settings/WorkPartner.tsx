import { useState } from "react";
import { api } from "@/state/store";
import { t } from "@/lib/i18n";
import { SETTINGS_INPUT } from "../SettingsPrimitives";

type Settings = { dots?: { id: string; otherThread: boolean; eligible: boolean }; partnerId: string | null; candidates: Array<{ id: string; name: string; title: string }> };

export function WorkPartner({ botId, threadId }: { botId: string; threadId: string }) {
  const [settings, setSettings] = useState<Settings>();
  const [status, setStatus] = useState<{ connected: boolean; authorized: boolean; subscription: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function load(partnerId?: string | null) {
    setBusy(true);
    setError("");
    try {
      const next = await api<Settings>(`/api/bots/${botId}/work-partner?threadId=${encodeURIComponent(threadId)}`, partnerId === undefined ? {} : {
        method: "PUT", body: JSON.stringify({ expected: settings?.partnerId ?? null, partnerId }),
      });
      setSettings(next);
      if (next.dots && next.partnerId === next.dots.id) setStatus(await api("/api/dots/status"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSettings(undefined);
    } finally { setBusy(false); }
  }
  return <div className="rounded-xl border border-hairline p-3">
    {settings ? <label className="flex flex-col gap-2">{t("botSettings.workPartner")}
      <select className={SETTINGS_INPUT} disabled={busy || settings.dots?.otherThread} value={settings.partnerId ?? ""} onChange={event => void load(event.target.value || null)}>
        <option value="">{t("botSettings.noWorkPartner")}</option>
        {settings.partnerId && !settings.candidates.some(peer => peer.id === settings.partnerId) && <option value={settings.partnerId}>{t("botSettings.partnerUnavailable")}</option>}
        {settings.candidates.map(peer => <option key={peer.id} value={peer.id}>{[peer.name, peer.title].filter(Boolean).join(" · ")}</option>)}
      </select>
    </label> : <button type="button" disabled={busy} onClick={() => void load()}>{t("botSettings.workPartner")}</button>}
    {settings?.dots && <p className="mt-2 text-sm text-ink-secondary">{t(settings.dots.otherThread ? "dots.otherThread" : settings.dots.eligible ? "dots.sharedContext" : "dots.bindingScope")}</p>}
    {settings?.dots && settings.partnerId === settings.dots.id && status && <p className="mt-2 text-sm text-ink-secondary" role="status">
      {t("dots.health", { local: t(status.connected ? "dots.online" : "dots.offline"), auth: t(status.authorized ? "dots.authorized" : "dots.unauthorized"),
        subscription: t(status.subscription === "active" ? "dots.active" : status.subscription === "missing" ? "dots.missing" : status.subscription === "ambiguous" ? "dots.ambiguous" : "dots.unknown") })}
    </p>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
