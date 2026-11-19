import { useId } from "react";
import type { BotModelPrefixSetting } from "../../../shared/bot-prompts";
import { t } from "@/lib/i18n";
import { useStore, type Bot } from "@/state/store";
import { Select } from "../Select";

export function BotModelPrefixButton({ bot, onOpen }: { bot: Bot; onOpen: () => void }) {
  const { state } = useStore();
  const instance = state.instances.find((item) => item.instanceId === bot.modelSelection.instanceId);
  if (!instance?.capabilities?.modelSystemPrefix || !bot.modelSelection.model) return null;
  return <button type="button" aria-haspopup="dialog" onClick={onOpen}
    className="ui-button ui-button-sm ui-button-pill my-1">{t("settings.modelSystemPrefix.title")}</button>;
}

export type PrefixMode = "inherit" | "off" | "custom";

export function PrefixModeSelect({ setting, mode, disabled, onChange }: {
  setting: BotModelPrefixSetting; mode: PrefixMode; disabled: boolean; onChange: (mode: PrefixMode) => void;
}) {
  const id = useId();
  const { state } = useStore();
  const name = state.instances.find((item) => item.instanceId === setting.instanceId)?.displayName;
  return <div className="flex flex-col gap-2">
    <label htmlFor={id} className="break-words text-[13px] text-ink-secondary" dir="auto">
      {name ?? setting.instanceId} · {setting.model}
    </label>
    <Select id={id} value={mode} disabled={disabled} onChange={(e) => onChange(e.target.value as PrefixMode)}>
      <option value="inherit">{t("botPrompts.prefixInherit")}</option>
      <option value="off">{t("botPrompts.prefixOff")}</option>
      <option value="custom">{t("botPrompts.prefixCustom")}</option>
    </Select>
    <p className="text-[12px] text-ink-secondary">{t("botPrompts.prefixHint")}</p>
  </div>;
}
