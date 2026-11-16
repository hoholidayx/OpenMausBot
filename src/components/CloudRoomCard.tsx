import { useState } from "react";

import type { CloudPlanSnapshot } from "../../electron/cloud-account.mjs";
import { usageBridge } from "./CloudUsageMeter";
import { useCloudPlanSnapshot } from "./CloudTrialNotice";
import { t } from "@/lib/i18n";
import { readRoomCardHidden, rememberRoomCardHidden, roomCardBusy, roomCardView, type RoomCardView } from "@/lib/room-card";
import { readUsageCardDismissed, usageCardView } from "@/lib/usage-meter";
import { useStore } from "@/state/store";

export function CloudRoomCardView({ view, onDismiss }: { view: RoomCardView; onDismiss: () => void }) {
  return (
    <section aria-labelledby="cloud-room-card-title" data-cloud-room-card="tip" data-room-cause={view.kind}
      className="mb-2 rounded-xl border border-hairline/50 bg-card p-3 text-ink shadow-sm">
      <h2 id="cloud-room-card-title" className="text-[13px] font-semibold leading-5">{view.title}</h2>
      <p className="mt-1 text-[12px] leading-relaxed text-ink">{view.cause}</p>
      <p className="mt-1.5 text-[12px] leading-relaxed text-ink-secondary">{view.tip}</p>
      <button type="button" className="ui-button mt-2.5 w-full justify-center" onClick={onDismiss}>{t("roomCard.gotIt")}</button>
    </section>
  );
}

/** The plan's snapshot as the room card reads it, from the bridge for the active place. */
function useCloudRoom(): { snapshot: CloudPlanSnapshot | null; teamHome: boolean } {
  const { state } = useStore();
  const bridge = usageBridge(state.config?.cloudHome === true);
  return { snapshot: useCloudPlanSnapshot(bridge), teamHome: Boolean(state.config?.cloudHome && state.config?.team) };
}

export function CloudRoomCard() {
  const { state } = useStore();
  const { snapshot, teamHome } = useCloudRoom();
  const usage = snapshot?.status === "paid" ? snapshot.usage ?? null : null;
  const [hidden, setHidden] = useState(readRoomCardHidden);
  const view = roomCardView({ room: snapshot?.status === "paid" ? snapshot.room : null, usage, busy: roomCardBusy(state.bots, state.config?.waitingForRoom), hidden, teamHome,
    usageCardShown: Boolean(usageCardView({ usage, teamHome, dismissed: readUsageCardDismissed() })) });
  const notNow = () => {
    if (!view) return;
    rememberRoomCardHidden(view.id);
    setHidden(view.id);
  };
  return view ? <CloudRoomCardView view={view} onDismiss={notNow} /> : null;
}
