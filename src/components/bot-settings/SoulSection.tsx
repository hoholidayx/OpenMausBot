import type { Bot } from "@/state/store";
import { SoulField } from "../SoulField";
import { ProposalStatus } from "./ProposalStatus";
import type { BotPatch } from "./useBotSettingsDerived";
import { t } from "@/lib/i18n";

export function SoulSection({ bot, patch, onOpenPrompts }: { bot: Bot; onOpenPrompts?: () => void; patch: (patch: BotPatch) => void }) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13px] leading-relaxed text-ink-secondary">
        {t("botSettings.soul.description")}
      </p>
      {onOpenPrompts && <button type="button" aria-haspopup="dialog" className="ui-button ui-button-sm ui-button-pill self-start" onClick={onOpenPrompts}>{t("botPrompts.title")}</button>}
      <ProposalStatus bot={bot} kind="chief" />
      <SoulField bot={bot} onPatch={patch} />
    </div>
  );
}
