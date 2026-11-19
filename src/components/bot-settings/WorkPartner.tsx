import { useState } from "react";
import { api } from "@/state/store";
import { t } from "@/lib/i18n";
import { SETTINGS_INPUT } from "../SettingsPrimitives";

type Settings = { partnerId: string | null; candidates: Array<{ id: string; name: string; title: string }> };

export function WorkPartner({ botId }: { botId: string }) {
  const [settings, setSettings] = useState<Settings>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function load(partnerId?: string | null) {
    setBusy(true);
    setError("");
    try {
      setSettings(await api<Settings>(`/api/bots/${botId}/work-partner`, partnerId === undefined ? {} : {
        method: "PUT", body: JSON.stringify({ expected: settings?.partnerId ?? null, partnerId }),
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSettings(undefined);
    } finally { setBusy(false); }
  }
  return <div className="rounded-xl border border-hairline p-3">
    {settings ? <label className="flex flex-col gap-2">{t("botSettings.workPartner")}
      <select className={SETTINGS_INPUT} disabled={busy} value={settings.partnerId ?? ""} onChange={event => void load(event.target.value || null)}>
        <option value="">{t("botSettings.noWorkPartner")}</option>
        {settings.partnerId && !settings.candidates.some(peer => peer.id === settings.partnerId) && <option value={settings.partnerId}>{t("botSettings.partnerUnavailable")}</option>}
        {settings.candidates.map(peer => <option key={peer.id} value={peer.id}>{[peer.name, peer.title].filter(Boolean).join(" · ")}</option>)}
      </select>
    </label> : <button type="button" disabled={busy} onClick={() => void load()}>{t("botSettings.workPartner")}</button>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
