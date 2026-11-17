import type { ComponentProps } from "react";

import { Composer } from "../Composer";
import { NewConversationInstead } from "../NewConversationInstead";
import { t } from "@/lib/i18n";

/** A room's composer, or, when this person can only view one of its bots, a line saying so: writing there makes every
 * bot in it answer. */
export function RoomComposer(props: ComponentProps<typeof Composer>) {
  if (props.members && !props.members.some(member => !member.hidden)) {
    return <p className="mx-auto w-full max-w-[820px] px-5 py-2 text-[13px] text-ink-secondary" role="status">{t("serverError.room.apiBotRequired")}</p>;
  }
  const viewOnly = props.members?.find((bot) => bot.yourAccess === "view");
  if (viewOnly) return <NewConversationInstead bot={viewOnly} room onNew={() => {}} />;
  return <Composer {...props} />;
}
