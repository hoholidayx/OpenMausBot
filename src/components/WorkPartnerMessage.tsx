import { useState } from "react";
import { api, type Message } from "@/state/store";
import { t } from "@/lib/i18n";

export function PartnerAuthor({ message }: { message: Message }) {
  if (!message.partnerResultId || !message.from) return null;
  return <div className="mb-1 text-[13px] font-semibold text-ink-secondary">{message.from.name}{message.partnerResultFailed && ` · ${t("toolDetail.failed")}`}</div>;
}

export function PartnerRelayFailure({ botId, threadId, rootId, attempt, retried, canRetry }: {
  botId: string; threadId: string; rootId: string; attempt: number; retried?: boolean; canRetry: boolean;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function retry() {
    setPending(true);
    setError("");
    try {
      await api(`/api/bots/${botId}/work-partner/relay-retry`, { method: "POST", body: JSON.stringify({ threadId, rootId, attempt }) });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPending(false);
    }
  }
  return <div className="flex flex-wrap items-center gap-2 text-sm text-ink-secondary">
    {t("server.partner.relayFailed")}
    {canRetry && !retried && <button type="button" disabled={pending} onClick={() => void retry()} className="underline">{t("workPartner.retryRelay")}</button>}
    {error && <span role="alert">{error}</span>}
  </div>;
}
