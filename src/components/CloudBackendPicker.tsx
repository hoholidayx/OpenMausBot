import type { CloudBackend } from "../../shared/wire";
import { t } from "@/lib/i18n";

export function CloudBackendPicker({
  value,
  compact = false,
  onChange,
}: {
  value: CloudBackend;
  compact?: boolean;
  onChange: (backend: "vps") => void;
}) {
  return (
    <div className="mt-3 rounded-lg bg-inset p-3">
      <div className="text-[12px] font-medium text-ink">{t("botAccess.cloud.selfHostedVps")}</div>
      <div className="mt-0.5 text-[12px] text-ink-secondary">
        {t(compact ? "botAccess.cloud.vpsDescription" : "botAccess.cloud.vpsAutoDescription")}
      </div>
      {value !== "vps" && (
        <button type="button" className="ui-button ui-button-sm mt-2" onClick={() => onChange("vps")}>
          {t("botAccess.cloud.selfHostedVps")}
        </button>
      )}
    </div>
  );
}
