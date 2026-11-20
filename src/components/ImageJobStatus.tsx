import { useState } from "react";
import { t } from "@/lib/i18n";
import { api, type Message } from "@/state/store";

function imageJobDetail(reason?: string) {
  switch (reason) {
    case "access_changed":
    case "other_installation": return "access";
    case "result_expired": return "expired";
    case "output_invalid": return "invalid";
    case "queue_full": return "busy";
    default: return reason?.startsWith("provider_") ? "provider" : undefined;
  }
}

export function ImageJobStatus({ threadId, messageId, job }: {
  threadId: string;
  messageId: string;
  job: NonNullable<Message["imageJob"]>;
}) {
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState(false);
  const detail = imageJobDetail(job.reason);

  async function check() {
    setChecking(true);
    setError(false);
    try {
      await api(`/api/threads/${threadId}/image-jobs/${messageId}/recheck`, { method: "POST", body: "{}" });
    } catch {
      setError(true);
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="text-sm text-ink-secondary" data-image-job={job.state}>
      <span role="status">{t(`imageJob.${job.state}`)}{detail && " " + t(`imageJob.detail.${detail}`)}</span>
      {job.recheck && (
        <button type="button" className="ms-2 text-accent underline" disabled={checking} onClick={() => void check()}>
          {t("imageJob.recheck")}
        </button>
      )}
      {error && <span role="alert" className="ms-2 text-danger">{t("imageJob.checkError")}</span>}
    </div>
  );
}
