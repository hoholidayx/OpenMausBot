import { useEffect, useState } from "react";
import { api, useStore } from "@/state/store";
import { brandStatus } from "@/lib/brand";
import { cornerPopupWaits, firstChatQuiet, firstReplyPending } from "@/lib/corner-popup";
import { dismissNotice, dismissNotices, GROK_MOVE_NOTICE, launchNotice, markLaunchNotice, nextNotice, noticeSeen, PHONE_UPDATE_NOTICE, phoneUpdateHint, SIMPLE_MODE_NOTICE } from "@/lib/notices";
import { SIMPLE_ONLY } from "@/lib/simple-only";
import { useAdvancedBackDue, useNewLookDue } from "@/lib/new-look";
import { useAdvancedMode } from "@/lib/interface-mode";
import { useSimpleModePromptSeen } from "@/lib/simple-mode-prompt";
import { welcomeFinishedThisLaunch, type WelcomeViewer } from "@/lib/onboarding";
import { launchDialogShown, markLaunchDialog } from "@/lib/launch-dialogs";
import { useUpdaterState } from "@/lib/updater";
import { phonePairingSettingsAction } from "@/lib/phone-pairing";
import { GrokMovePopup, type GrokMovePopupAction } from "./GrokMovePopup";
import { GrokMoveDialog } from "./lazy-screens";
import { useDesktopNotices, useOtherDialogOpen } from "./notice-dialogs";
import { localDesktopPage } from "./onboarding/WelcomeGate";
import { useMausBotWelcomeDue } from "./MausBotWelcome";
import { NewLookNotice } from "./NewLookNotice";
import { PhoneUpdateCard, phonesToTell, useRetiredLinkPhones } from "./PhoneUpdateNotice";
import { SimpleModePrompt } from "./SimpleModePrompt";

/** A first run lands in its Chief's chat, whose first messages arrive one at a time; the Grok Bot popup follows them. */
const FIRST_MESSAGES_MS = 6_000;

export function AppNotices({ quiet = false, viewer = null }: { quiet?: boolean; viewer?: WelcomeViewer | null }) {
  const { state, dispatch } = useStore();
  const remote = window.ogb?.remoteClient?.active === true;
  const local = localDesktopPage();
  const desktop = remote ? undefined : window.ogb?.desktopNotices;
  const desktopState = useDesktopNotices(desktop);
  const [closed, setClosed] = useState(false);
  const [grokOpen, setGrokOpen] = useState(false);
  const [grokLanded, setGrokLanded] = useState(false);
  const updater = useUpdaterState();
  const mausBot = useMausBotWelcomeDue(viewer);
  // Phones whose older app lost its way in: this computer's own page only, never a Cloud, a server's page or client mode.
  const linkPhones = useRetiredLinkPhones(!remote && local);
  const record = state.config?.onboarding;
  // Every page with the app's chrome, desktop or Cloud, new install or not: once per browser, as the mode is. With Simple
  // the only mode, its place goes to the word about the new look, only where Advanced was on; a browser put back on
  // Advanced gets the word that it is back there instead.
  const promptSeen = useSimpleModePromptSeen(), newLookDue = useNewLookDue(), backDue = useAdvancedBackDue(), advanced = useAdvancedMode();
  const advancedBack = backDue && advanced;
  const simpleDue = SIMPLE_ONLY ? newLookDue : advancedBack || !promptSeen;
  const simpleBlocked = useOtherDialogOpen(simpleDue) || Boolean(state.liveCall && state.liveCall.status !== "ended");
  const waits = cornerPopupWaits(state, updater, { quiet, idle: true, viewer, duringFirstChat: true });
  const firstChat = firstReplyPending(state);
  const afterWelcome = welcomeFinishedThisLaunch() || launchDialogShown() === "mausbot" || firstChat;
  const mausBotFirst = mausBot.due;
  // The Grok Bot popup: once for everyone who can add a bot, the one thing a first chat may be interrupted by. Nothing reads
  // this computer for it: GrokMoveDialog does that, once opened.
  const grokDue = !remote && viewer?.canSave !== false && !state.config?.team && brandStatus().source !== "file"
    && launchDialogShown() !== "mausbot" && !noticeSeen(record, GROK_MOVE_NOTICE) && !desktopState?.seen.includes(GROK_MOVE_NOTICE);
  const grokBlocked = useOtherDialogOpen(grokDue) || Boolean(state.liveCall && state.liveCall.status !== "ended");
  const grokLanding = welcomeFinishedThisLaunch() && !grokLanded;
  useEffect(() => {
    if (!grokDue || !grokLanding || waits) return;
    const timer = setTimeout(() => setGrokLanded(true), FIRST_MESSAGES_MS);
    return () => clearTimeout(timer);
  }, [grokDue, grokLanding, waits]);
  const grokNow = !grokDue ? false
    : !viewer || (desktop && !desktopState) || firstChat === null || mausBotFirst || grokLanding || grokBlocked ? null : true;
  const retiredPhones = phonesToTell(linkPhones, record);
  const phoneNow = retiredPhones?.length === 0 ? false
    : retiredPhones === undefined || !viewer || mausBotFirst || (state.liveCall && state.liveCall.status !== "ended") ? null : true;
  const launch = launchNotice();
  const notice = waits ? null
    : firstChatQuiet(state) ? (grokNow === true && (launch === null || launch === GROK_MOVE_NOTICE) ? GROK_MOVE_NOTICE : null)
    : nextNotice({
    [GROK_MOVE_NOTICE]: grokNow,
    [PHONE_UPDATE_NOTICE]: phoneNow,
    // Never in the launch whose welcome just finished, nor over MausBot's first-launch card.
    [SIMPLE_MODE_NOTICE]: !simpleDue || afterWelcome === true ? false : afterWelcome === null || mausBotFirst || simpleBlocked ? null : true,
  }, launch, closed);

  useEffect(() => {
    if (!notice) return;
    markLaunchNotice(notice);
    if (notice === GROK_MOVE_NOTICE || notice === SIMPLE_MODE_NOTICE) markLaunchDialog("notices");
  }, [notice]);

  const save = (id: string) => {
    const patch = dismissNotice(record, id);
    if (patch) void api("/api/config", { method: "PUT", body: JSON.stringify(patch) })
      .then(config => dispatch({ type: "configStatus", config })).catch(() => {});
  };
  const close = () => setClosed(true);
  if (grokOpen) return <GrokMoveDialog onClose={() => setGrokOpen(false)} />;
  if (!notice) return null;

  if (notice === GROK_MOVE_NOTICE) {
    const done = (action: GrokMovePopupAction) => {
      close(); save(GROK_MOVE_NOTICE);
      void desktop?.seen(GROK_MOVE_NOTICE).catch(() => {});
      if (action === "start") setGrokOpen(true);
    };
    return <GrokMovePopup onDone={done} />;
  }

  if (notice === PHONE_UPDATE_NOTICE && retiredPhones?.length) {
    const done = () => { close(); const patch = dismissNotices(record, retiredPhones.map(phone => phoneUpdateHint(phone.id)));
      if (patch) void api("/api/config", { method: "PUT", body: JSON.stringify(patch) }).then(config => dispatch({ type: "configStatus", config })).catch(() => {}); };
    return <PhoneUpdateCard phones={retiredPhones} onOpen={() => { done(); dispatch(phonePairingSettingsAction()); }} onDismiss={done} />;
  }

  if (notice === SIMPLE_MODE_NOTICE) {
    return SIMPLE_ONLY || advancedBack ? <NewLookNotice onClose={close} back={advancedBack} /> : <SimpleModePrompt onClose={close} />;
  }

  return null;
}
