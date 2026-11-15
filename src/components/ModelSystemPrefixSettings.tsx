import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { BOT_PROFILE_LIMITS } from "../../shared/bot-profile";
import { t } from "@/lib/i18n";
import { api, type InstanceInfo } from "@/state/store";
import { Select } from "./Select";
import { FIELD_EDGE, SETTINGS_INPUT, SettingsField } from "./SettingsPrimitives";

const PATH = "/api/model-system-prefixes";
const CUSTOM_MODEL = "custom";

export function useModelSystemPrefixConnections(instances: readonly InstanceInfo[]) {
  const signature = JSON.stringify(instances.map(({ instanceId, driverKind, readOnly }) => [instanceId, driverKind, Boolean(readOnly)]));
  const [editable, setEditable] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    void api<{ instances: string[] } | undefined>(PATH).then(
      (result) => { if (!cancelled) setEditable(result?.instances ?? []); },
      () => { if (!cancelled) setEditable([]); },
    );
    return () => { cancelled = true; };
  }, [signature]);
  return editable;
}

function PrefixField({ instanceId, model, drafts, saving, setSaving }: {
  instanceId: string;
  model: string;
  drafts: Map<string, string>;
  saving: boolean;
  setSaving: (saving: boolean) => void;
}) {
  const path = PATH + "?" + new URLSearchParams({ instanceId, model });
  const [text, setText] = useState(() => drafts.get(model) ?? "");
  const [stored, setStored] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void api<{ text: string }>(path).then(({ text }) => {
      if (cancelled) return;
      setStored(text);
      setText(drafts.get(model) ?? text);
    }, () => {
      if (!cancelled) setError(t("settings.modelSystemPrefix.loadError"));
    });
    return () => { cancelled = true; };
  }, [path, model, drafts, loadAttempt]);

  const value = text.trim() ? text : "";
  const tooLong = new TextEncoder().encode(value).byteLength > BOT_PROFILE_LIMITS.soul;
  const canSave = stored !== null && value !== stored && !tooLong && !saving;
  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setError("");
    try {
      const result = await api<{ text: string }>(path, { method: "PUT", body: JSON.stringify({ text: value }) });
      drafts.delete(model);
      setText(result.text);
      setStored(result.text);
      setSaved(true);
    } catch {
      setError(t("settings.modelSystemPrefix.saveError"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="flex flex-col gap-2" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <SettingsField label={t("settings.modelSystemPrefix.text")}>
        <textarea
          dir="auto"
          rows={4}
          className={`w-full rounded-lg ${FIELD_EDGE} bg-app px-2 py-1.5 text-[13px] leading-5 text-ink outline-none focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-40`}
          value={text}
          disabled={stored === null || saving}
          onChange={(event) => {
            const next = event.target.value;
            drafts.set(model, next);
            setText(next);
            setSaved(false);
            setError("");
          }}
        />
      </SettingsField>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" className="ui-button ui-button-primary" disabled={!canSave}>
          {saving ? t("settings.threads.saving") : t("common.save")}
        </button>
        {stored === null && error && (
          <button type="button" className="ui-button" onClick={() => { setError(""); setLoadAttempt((value) => value + 1); }}>
            {t("settings.profile.retry")}
          </button>
        )}
        {stored === null && !error && <span role="status" className="text-[12px] text-ink-secondary">{t("botOverview.loading")}</span>}
        {saved && <span role="status" className="text-[12px] text-ink-secondary">{t("common.saved")}</span>}
      </div>
      {(tooLong || error) && (
        <p role="alert" className="text-[12px] text-danger">{tooLong ? t("settings.modelSystemPrefix.tooLong") : error}</p>
      )}
    </form>
  );
}

export function ModelSystemPrefixSettings({ instance }: { instance: InstanceInfo }) {
  const contentId = useId();
  const drafts = useRef(new Map<string, string>());
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState(() => instance.models.default ? "model:" + instance.models.default : CUSTOM_MODEL);
  const [custom, setCustom] = useState("");
  const model = selected === CUSTOM_MODEL ? custom.trim() : selected.slice("model:".length);
  const options = instance.models.options;

  return (
    <div className="mt-3 flex min-w-0 flex-col gap-2">
      <button
        type="button" aria-expanded={open} aria-controls={contentId}
        className="ui-button self-start"
        disabled={saving}
        onClick={() => setOpen((value) => !value)}
      >
        {t("settings.modelSystemPrefix.title")} <ChevronDown size={14} aria-hidden />
      </button>
      <div id={contentId} hidden={!open}>
        {open && (
          <div className="flex min-w-0 flex-col gap-3">
            <p className="break-words text-[12px] text-ink-secondary">{instance.displayName}</p>
            <SettingsField label={t("model.simple.model")}>
              <Select value={selected} disabled={saving} onChange={(event) => setSelected(event.target.value)}>
                {selected !== CUSTOM_MODEL && !options.some((option) => option.id === model) && <option value={selected}>{model}</option>}
                {options.map((option) => <option key={option.id} value={"model:" + option.id}>{option.label}</option>)}
                <option value={CUSTOM_MODEL}>{t("settings.modelSystemPrefix.customModel")}</option>
              </Select>
            </SettingsField>
            {selected === CUSTOM_MODEL && (
              <SettingsField label={t("settings.modelSystemPrefix.modelId")}>
                <input dir="auto" className={SETTINGS_INPUT} value={custom} disabled={saving} onChange={(event) => setCustom(event.target.value)} />
              </SettingsField>
            )}
            {model && (
              <>
                {selected !== CUSTOM_MODEL && <p className="break-all font-mono text-[12px] text-ink-secondary">{model}</p>}
                <p className="text-[12px] text-ink-secondary">{t("settings.modelSystemPrefix.help")}</p>
                <PrefixField key={model} {...{ instanceId: instance.instanceId, model, drafts: drafts.current, saving, setSaving }} />
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
