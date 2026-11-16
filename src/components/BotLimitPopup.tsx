import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { botRoom, closeBotLimit, planRefusal, showBotLimit, useBotLimitReason, useCreatedPausedBot, type BotLimitReason } from "@/lib/bot-limit";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useStore } from "@/state/store";
import { MausAvatar } from "./Avatar";
import { AwakeBotsPicker } from "./AwakeBotsPicker";
import { PRIMARY_BUTTON } from "./NoticeCard";

const POPUP = "[data-bot-limit-popup]";
const TITLE = "bot-limit-title";
const BODY = "bot-limit-body";
/** Above every dialog a person can press a create button in. */
const LAYER = "z-[80]";

export function BotLimitPopup() {
  const { state } = useStore();
  const turns = state.config?.planTurns, loaded = Boolean(state.config), seen = useRef<number | undefined | null>(null);
  useEffect(() => {
    if (!loaded) return;
    const next = planRefusal(seen.current, turns);
    seen.current = next.seen;
    if (next.show) showBotLimit(next.show);
  }, [loaded, turns?.refusedAt]);
  const reason = useBotLimitReason(), created = useCreatedPausedBot();
  return reason ? <BotLimitDialog reason={reason} created={created} onClose={closeBotLimit} /> : null;
}

function BotLimitDialog({ reason, created, onClose }: { reason: BotLimitReason; created: string | null; onClose: () => void }) {
  const { state } = useStore();
  const limit = state.config?.botLimit, awake = state.config?.awakeLimit;
  const noRoom = limit !== undefined && botRoom(state) === 0;
  const picking = (reason === "paused" || reason === "created") && awake !== undefined;
  const createdName = state.bots.find((bot) => bot.id === created)?.name ?? "";

  useEffect(() => {
    document.querySelector<HTMLElement>(`${POPUP} button`)?.focus();
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const root = document.querySelector<HTMLElement>(POPUP);
      if (!root) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      event.preventDefault();
      event.stopPropagation();
      const controls = [...root.querySelectorAll<HTMLButtonElement>("button")].filter((button) => !button.disabled);
      const at = controls.indexOf(document.activeElement as HTMLButtonElement), step = event.shiftKey ? -1 : 1;
      controls[at === -1 ? (step > 0 ? 0 : controls.length - 1) : (at + step + controls.length) % controls.length]?.focus();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const title = reason === "tasks" ? t("botLimit.tasks.title", { count: state.config?.planTurns?.running ?? 2 })
        : reason === "created" ? t("botLimit.created.title", { name: createdName })
          : reason === "paused" ? t("botLimit.paused.title", { count: awake ?? limit ?? 5 })
            : noRoom ? t("botLimit.title", { count: limit }) : t("botLimit.titleTooMany");
  const body = reason === "tasks" ? t("botLimit.tasks.body") : reason === "paused" ? t("botLimit.paused.body", { count: awake ?? limit ?? 5 })
    : reason === "created" ? t("botLimit.created.body", { count: awake ?? 5 }) : null;

  return createPortal(
      <div className={cn("ui-scrim fixed inset-0 flex items-center justify-center p-4 motion-reduce:animate-none", LAYER)}>
        <div role="dialog" aria-modal="true" aria-labelledby={TITLE} aria-describedby={BODY} data-bot-limit-popup=""
          className="ui-modal animate-pop-in relative flex w-[min(380px,calc(100vw-32px))] flex-col items-center border-0 px-6 pb-3 pt-8 text-center text-ink motion-reduce:animate-none">
          <div aria-hidden="true"><MausAvatar color="chrome" size={52} state="idle" animated={false} /></div>
          <h2 id={TITLE} className="mt-5 text-[19px] font-semibold leading-6 tracking-[-0.012em] [text-wrap:balance]">{title}</h2>
          <p id={BODY} className="mt-1.5 text-[14px] leading-5 text-ink-secondary [text-wrap:pretty]">{body ?? t("botLimit.body")}</p>
          {picking && <AwakeBotsPicker limit={awake} onSaved={onClose} {...(reason === "created" && created ? { swapIn: created } : {})} />}
          <button type="button" onClick={onClose} className={cn(PRIMARY_BUTTON, "mt-5 w-full justify-center")}>{t("roomCard.gotIt")}</button>
          <button type="button" onClick={onClose} aria-label={t("common.close")} className="ui-icon-button absolute end-3 top-3"><X size={16} /></button>
        </div>
      </div>, document.body);
}
