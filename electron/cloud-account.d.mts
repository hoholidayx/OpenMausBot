/** Remove from list's answer: done (`removed`), refused by the Admin now, the Cloud no longer theirs (`gone`), an Admin
 * without it (`unsupported`), or no answer (`failed`). */
export type CloudRemoveOutcome = "removed" | "refused" | "gone" | "unsupported" | "failed";
export interface CloudAccountState {
  status: "signed-out" | "connecting" | "connected" | "reauth-required" | "unavailable";
  message?: string;
  enrollment?: { userCode: string; expiresAt: number };
  account?: { id: string; email: string };
  deviceId?: string;
  expiresAt?: number;
  /** Only a current server-verified session can include an entitlement
   * (verified within the last few minutes; a failed re-check keeps it).
   * `plan` "pro" means any paid plan; `tier` names it ("starter", "personal",
   * "pro", "max", or one newer than this app) when the Admin sends one. */
  entitlement?: { plan: "free" | "pro"; tier?: string; status: "active" | "inactive"; expiresAt: number | null; version: number };
  verifiedAt?: number;
  verifiedUntil?: number;
  /** Connected, but the last checks with OMB Cloud failed; the snapshot is the last verified one. */
  checking?: true;
  /** Not connected (unavailable, or the sign-in ended): the paid plan last
   * verified for this account, for display only. It activates nothing. */
  lastPlan?: { tier?: string; active: boolean };
  /** The person's Cloud home machine, when their plan has one. */
  machine?: import("./cloud-home.mjs").CloudMachine;
  /** Connected: the teams this account is in, each with its Cloud; absent while it is in none. */
  teams?: import("./cloud-home.mjs").CloudTeam[];
  /** Connected, with no Cloud of the account's own: the team it was invited into, which opens first, before any plan is
   * offered (the Admin's `landing`). */
  landing?: { teamId: string };
  /** Connected to an Admin that lists every Cloud of the person's (contract v1 `clouds`): each of them, My Cloud first.
   * Absent from an older Admin, whose `machine` and `teams` say everything. */
  clouds?: import("./cloud-list.mjs").CloudListEntry[];
  /** With `clouds`, for the account a Team plan with organizations is billed to: whether ＋ may add one to it now. */
  organizations?: import("./cloud-list.mjs").CloudOrganizations;
  /** The newest OpenMausBot release the Admin knows, while it follows releases (with `clouds`); absent otherwise. */
  latestVersion?: string;
  /** A payment OMB Cloud received and is still linking to this account. */
  purchase?: import("./cloud-home.mjs").CloudPurchase;
  /** Connected: the free trial on this account's Cloud, when the Admin says (display only). */
  trial?: import("./cloud-home.mjs").CloudTrial;
  /** Connected: the trial's Claude credit, while it lasts. */
  credit?: import("./cloud-home.mjs").CloudCredit;
  /** Connected with an active plan: its allowances and this month's use of them, and the bigger plans the app can move to (display only). */
  usage?: import("./cloud-home.mjs").CloudUsage;
  /** Connected beside `usage`: the Cloud is short on resources. */
  room?: import("./cloud-home.mjs").CloudRoom;
  /** This app talks to the staging Admin (OMB_CLOUD_STAGING=1): test payments, test Clouds. */
  staging?: true;
  /** Connected: opening My Cloud waits for it to wake. */
  waking?: true;
  /** Connected: the plan's renewal, only while this account pays for a plan that runs: what Cancel and Keep act on (display only). */
  renewal?: import("./cloud-list.mjs").CloudRenewal;
}
/** The cancel sheet's reasons. */
export type CloudCancelAnswer = "feature" | "price" | "setup" | "broken" | "later" | "other";
/** The cancel sheet's survey: one reason (words without one are kept as `other`) and two optional boxes, at most 2,000 characters each. */
export interface CloudCancelSurvey { answer?: CloudCancelAnswer | null; expected?: string; improve?: string }
/** What Cancel or Keep my plan did: `cancelled` (with when it ends, from the Admin's answer, and whether the survey was kept),
 * `kept`, `browser` (this Admin can't do it from the app yet, so the Cloud page's billing opened instead), or `failed`
 * (nothing changed). */
export type CloudRenewalResult =
  | { outcome: "cancelled"; renewal: import("./cloud-list.mjs").CloudRenewal | null; surveyed: boolean; state: CloudAccountState }
  | { outcome: "kept"; state: CloudAccountState }
  | { outcome: "browser" }
  | { outcome: "failed"; state: CloudAccountState };
/** How the Cloud is shown in this app's switcher and Settings → Servers. */
export interface CloudHomeLook { name: string; color: import("./cloud-buy.mjs").CloudColor }
/** What adding an organization did: `added` (its Cloud is being set up), `taken` (another of the plan's has that name),
 * `blocked` with the Admin's reason, `unsupported` (an Admin without organizations), or `failed` (nothing was added). */
export type OrganizationAddResult =
  | { outcome: "added"; cloudId?: string }
  | { outcome: "taken" | "unsupported" | "failed" }
  | { outcome: "blocked"; blocked: import("./cloud-list.mjs").OrganizationBlock };
export interface CloudAccountBridge {
  state(): Promise<CloudAccountState>;
  refresh(): Promise<CloudAccountState>;
  openDashboard(): Promise<CloudAccountState>;
  /** Cancel trial / Cancel plan, after the survey when it says anything; Keep my plan. The Cloud is the verified session's own, never the page's. Absent on an older app. */
  cancelPlan?(survey: CloudCancelSurvey | null): Promise<CloudRenewalResult>;
  keepPlan?(): Promise<CloudRenewalResult>;
  onState(callback: (state: CloudAccountState) => void): () => void;
  files?: import("./cloud-sync.mjs").CloudFilesBridge;
}
export interface RailOpenResult { outcome: "switched" | "moving" | "sign-in" | "gone" | "failed"; email?: string }
/** `added`: kept signed in, not switched to, while this computer's move finishes; `already`: that account is the one signed in. */
export interface CloudPlanSnapshot {
  status: "paid" | "attention" | "checking" | "signin" | "none";
  tier?: string;
  /** Verified: the free trial on the Cloud and its Claude credit. */
  trial?: import("./cloud-home.mjs").CloudTrial;
  credit?: import("./cloud-home.mjs").CloudCredit;
  /** The trial's popup due now, not yet shown today on either page. */
  notice?: import("./cloud-home.mjs").CloudTrialState;
  /** Verified: the plan sleeps when idle. */
  sleeps?: true;
  /** This window's home is this Cloud: the person's bots moved here (home-window.mjs). */
  home?: true;
  /** Verified, with an active plan: its allowances and their use this month (the usage meter). */
  usage?: import("./cloud-home.mjs").CloudUsage;
  /** Verified, beside `usage`: this Cloud is short on room, and the plan that fixes it or a tip (the room card). */
  room?: import("./cloud-home.mjs").CloudRoom;
  /** Verified, while this account pays for a plan that runs: what Cancel and Keep act on. */
  renewal?: import("./cloud-list.mjs").CloudRenewal;
}
export interface CloudPlanBridge {
  state(): Promise<CloudPlanSnapshot>;
  manage(): Promise<void>;
  /** This device's MausBot Cloud sign-in, again, once it has ended: only from the person's click. */
  signIn?(): Promise<void>;
  /** The trial's popup due now was shown: main shows it no more today. Absent on an older app. */
  noticeSeen?(): Promise<void>;
  /** Cancel trial / Cancel plan and Keep my plan on the Cloud's own page (only from the person's click). Absent on an older app. */
  keep?(): Promise<CloudRenewalResult>;
}
