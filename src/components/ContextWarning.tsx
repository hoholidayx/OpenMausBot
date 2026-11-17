import { useState } from "react";
import { Gauge } from "lucide-react";

import { cn } from "@/lib/cn";
import { roomContextWarnings, threadContextWarning } from "@/lib/context-warning";
import { t } from "@/lib/i18n";
import { api, useStore, type Bot, type Group, type Message } from "@/state/store";

const pill = "flex items-center gap-1.5 rounded-full border border-warning/40 bg-warning/10 px-2.5 py-1 text-[13px] text-ink";
const action = "rounded-full px-1.5 font-medium text-accent hover:underline disabled:cursor-not-allowed disabled:opacity-50 disabled:no-underline";

export function useContextAction() {
  const { dispatch } = useStore();
  const [pending, setPending] = useState(false);
  const run = (path: string, body: unknown) => {
    if (pending) return;
    setPending(true);
    void api(path, { method: "POST", body: JSON.stringify(body) })
      .catch((cause) => dispatch({ type: "error", message: cause instanceof Error ? cause.message : String(cause) }))
      .finally(() => setPending(false));
  };
  return { pending, run };
}

export function ThreadContextWarningView({ name, percent, busy, pending, detail, onCompact }: {
  name: string; percent: number; busy: boolean; pending: boolean; detail?: string; onCompact?: () => void;
}) {
  return (
    <span role="status" data-testid="context-warning" className={pill}
      title={onCompact ? t("contextWarning.threadHint", { name, percent }) : undefined}>
      <Gauge size={13} className="shrink-0 text-warning" aria-hidden="true" />
      <span className="tabular-nums">{t("contextWarning.short", { percent })}</span>
      {onCompact && <button type="button" className={action} disabled={busy || pending} onClick={onCompact}
        title={busy ? t("contextWarning.busy") : undefined}>
        {pending ? t("contextWarning.compacting") : t("contextWarning.compactNow")}
      </button>}
      {detail && <span className="text-ink-secondary">{detail}</span>}
    </span>
  );
}

export function ThreadContextWarning({ bot, messages }: { bot: Bot; messages: readonly Message[] }) {
  const { state } = useStore();
  const task = bot.tasks?.find((task) => task.threadId === bot.threadId);
  const instanceId = task?.modelSelection?.instanceId ?? bot.modelSelection.instanceId;
  const providerManaged = state.instances.find((instance) => instance.instanceId === instanceId)?.capabilities?.contextCompactionOwner === "provider";
  const warning = threadContextWarning(task?.usage, messages, !providerManaged);
  const { pending, run } = useContextAction();
  const [explained, setExplained] = useState<string | null>(null);
  if (!warning) return null;
  return (
    <ThreadContextWarningView name={bot.name} percent={warning.percent} busy={!providerManaged && Boolean(bot.busy)} pending={pending}
      detail={providerManaged && explained === bot.threadId ? t("serverError.chat.providerManagedContext") : undefined}
      onCompact={providerManaged ? () => setExplained(bot.threadId) : () => run(`/api/bots/${bot.id}/compact`, { threadId: bot.threadId })} />
  );
}

export function RoomContextBadge({ percent }: { percent: number }) {
  return (
    <span className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border border-app bg-warning"
      role="img" aria-label={t("contextWarning.short", { percent })} />
  );
}

export function RoomContextWarningsView({ warnings, pendingBotId, onCompact }: {
  warnings: ReturnType<typeof roomContextWarnings>;
  pendingBotId: string | null;
  onCompact: (botId: string) => void;
}) {
  if (!warnings.length) return null;
  return (
    <div className="flex flex-col gap-1" data-testid="room-context-warnings">
      {warnings.map(({ bot, percent }) => (
        <p key={bot.id} role="status" className={cn(pill, "w-fit")}>
          <Gauge size={13} className="shrink-0 text-warning" aria-hidden="true" />
          <span>{t("contextWarning.room", { name: bot.name, percent })}</span>
          <button type="button" className={action} disabled={pendingBotId !== null} onClick={() => onCompact(bot.id)}>
            {pendingBotId === bot.id ? t("contextWarning.compacting") : t("contextWarning.compactNow")}
          </button>
        </p>
      ))}
    </div>
  );
}

export function RoomContextWarnings({ group, members }: { group: Group; members: readonly Bot[] }) {
  const warnings = roomContextWarnings(group, members);
  const { pending, run } = useContextAction();
  const [target, setTarget] = useState<string | null>(null);
  if (!warnings.length) return null;
  return (
    <div className="w-full px-5 pb-1">
      <RoomContextWarningsView warnings={warnings} pendingBotId={pending ? target : null} onCompact={(botId) => {
        setTarget(botId);
        run(`/api/groups/${group.id}/members/${botId}/compact`, { threadId: group.threadId });
      }} />
    </div>
  );
}
