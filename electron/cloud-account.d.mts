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
/** The email-code sign-in (cloud-signin.mjs). `sent`: the code is on its
 * way (`resendAt`: when another may be asked for). `browser`: this Cloud signs
 * in only in the browser (single sign-on there, or an older Admin). */
export type CloudSignInStart =
  | { outcome: "sent"; email: string; expiresAt: number; resendAt: number; /** False: new accounts are closed, so only an existing one gets a code. */ signupOpen: boolean }
  | { outcome: import("./cloud-signin.mjs").CloudSignInStartFailure };
/** `signed-in`: stored and read like the browser sign-in; `wrong-code` says
 * the tries left; `expired` needs a new code. */
export type CloudSignInVerify =
  | { outcome: "signed-in"; state: CloudAccountState }
  | { outcome: "wrong-code"; triesLeft: number }
  | { outcome: Exclude<import("./cloud-signin.mjs").CloudSignInVerifyFailure, "wrong-code"> };
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
  begin(): Promise<CloudAccountState>;
  /** Only when the sign-in has ended: forget it and start a new one. */
  signInAgain(): Promise<CloudAccountState>;
  reopen(): Promise<CloudAccountState>;
  cancel(): Promise<CloudAccountState>;
  refresh(): Promise<CloudAccountState>;
  signOut(): Promise<CloudAccountState>;
  openDashboard(): Promise<CloudAccountState>;
  /** Lists the Cloud machine under Servers and opens it in this window. */
  connectHome(): Promise<CloudAccountState>;
  /** The same, opening the Cloud's Settings on its phone pairing. */
  connectHomeForPhone(): Promise<CloudAccountState>;
  /** Opens a team's Cloud in this window, as the switcher does: one the verified session lists, by its id. Absent on an older app. */
  openTeam?(teamId: string): Promise<void>;
  /** Cancel trial / Cancel plan, after the survey when it says anything; Keep my plan. The Cloud is the verified session's own, never the page's. Absent on an older app. */
  cancelPlan?(survey: CloudCancelSurvey | null): Promise<CloudRenewalResult>;
  keepPlan?(): Promise<CloudRenewalResult>;
  onState(callback: (state: CloudAccountState) => void): () => void;
  files?: import("./cloud-sync.mjs").CloudFilesBridge;
}
/** Who is signed in on this device, as the You menu shows it. `signIn`: this account's sign-in has ended here. */
export interface AccountRow { id: string; email: string; signIn?: true }
export interface AccountsView { active: AccountRow | null }
export interface AccountSwitchResult { outcome: "switched" | "signed-out" | "moving" | "sign-in" | "gone" | "failed"; email?: string; view: AccountsView }
/** What a click on a place of another account answers when it didn't switch: nothing moved. `sign-in`: that sign-in has ended. */
export interface RailOpenResult { outcome: "switched" | "moving" | "sign-in" | "gone" | "failed"; email?: string }
/** `added`: kept signed in, not switched to, while this computer's move finishes; `already`: that account is the one signed in. */
export type AccountAddResult =
  | { outcome: "switched" | "added" | "already"; email?: string; view: AccountsView }
  | { outcome: "wrong-code"; triesLeft: number }
  | { outcome: Exclude<import("./cloud-signin.mjs").CloudSignInVerifyFailure, "wrong-code"> };
/** This app's own pages only: main refuses any other page. Absent on an older app. */
export interface AccountsBridge {
  list(): Promise<AccountsView>;
  /** Removes that account from this device; the window goes to another signed in here, else the app is signed out. */
  signOut(id: string): Promise<AccountSwitchResult>;
  /** Add another account: the active account goes on until this succeeds. The attempt and the token stay in main. */
  addStart(email: string): Promise<CloudSignInStart>;
  addVerify(code: string): Promise<AccountAddResult>;
  addBrowser(): Promise<{ outcome: "browser" | "failed"; code?: string }>;
  addReopen(): Promise<void>;
  /** How the browser's way ended, asked once the list changes: null until it has. */
  addResult(): Promise<{ outcome: "switched" | "added" | "already" | "failed"; email?: string } | null>;
  addCancel(): Promise<void>;
  sheetPending(): Promise<boolean>;
  sheetClosed(): Promise<void>;
  onChanged(callback: () => void): () => void;
  onOpenSheet(callback: () => void): () => void;
}
/** Any place's own page, from the person's click: the accounts sheet opens on the rail's page, and this page learns nothing of them. */
export interface AccountSheetBridge { offered(): Promise<boolean>; open(): Promise<void> }
/** On the person's own Cloud, open in this app's window: the plan, read
 * only, Manage in the browser, and Sign in again. No account, credential or address. */
/** `signin`: this computer's sign-in ended; `tier` names the plan last verified, if any. */
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
  cancel?(survey: CloudCancelSurvey | null): Promise<CloudRenewalResult>;
  keep?(): Promise<CloudRenewalResult>;
}

export declare const CLOUD_ORIGIN: string;
export declare const STAGING_CLOUD_ORIGIN: string;
export declare function cloudTarget(env?: Record<string, string | undefined>): {
  origin: string; staging: boolean;
  /** Under userData: the sign-in, saved servers, Files' folder, the Cloud's chosen name. */
  file: string; saved: string; places: string; environments: string; sync: string; look: string;
};
export declare const CLOUD_CANCEL_ANSWERS: readonly CloudCancelAnswer[];
/** The survey as main sends it (trimmed; words without a reason as `other`), or null when it says nothing or isn't one. */
export declare function cancelSurvey(input: unknown): { answer: CloudCancelAnswer; expected?: string; improve?: string } | null;
export declare function cloudOrigin(value?: string, fixture?: boolean): string;
export interface CloudAccountStore {
  read(): Promise<unknown>;
  write(value: unknown): Promise<void>;
}
export declare function createCloudAccountStore(options: {
  file: string;
  encryption: {
    available(): boolean | Promise<boolean>;
    encrypt(value: string): Buffer | Promise<Buffer>;
    /** A string, or Electron 43's { shouldReEncrypt, result } (safeStorage.decryptStringAsync). */
    decrypt(value: Buffer): string | { result: string } | Promise<string | { result: string }>;
  };
}): CloudAccountStore;
export interface CloudAccountClient {
  state(): CloudAccountState;
  start(): Promise<CloudAccountState>;
  begin(): Promise<CloudAccountState>;
  /** Only when the sign-in has ended: forget it and start a new one. */
  signInAgain(): Promise<CloudAccountState>;
  reopen(): Promise<CloudAccountState>;
  cancel(): Promise<CloudAccountState>;
  refresh(): Promise<CloudAccountState>;
  signOut(): Promise<CloudAccountState>;
  openDashboard(): Promise<CloudAccountState>;
  emailStart(email: string): Promise<CloudSignInStart>;
  emailVerify(code: string): Promise<CloudSignInVerify>;
  emailCancel(): void;
  /** POST /api/cloud/desktop/feedback when the survey says anything (never in the cancel's way), then POST
   * /api/cloud/desktop/clouds/<the session's own Cloud>/cancel. */
  cancelPlan(survey: unknown): Promise<CloudRenewalResult>;
  /** POST /api/cloud/desktop/clouds/<the session's own Cloud>/keep. */
  keepPlan(): Promise<CloudRenewalResult>;
  /** POST /api/cloud/desktop/room: Not now on the room card for the session's own Cloud; false when it couldn't be said. */
  homeTarget(): { origin: string } | null;
  /** The Admin's last word on a Cloud whose plan sleeps; null for any other. */
  power(): import("./cloud-power.mjs").CloudPower | null;
  /** Asks the Admin to start a sleeping Cloud (POST /api/cloud/desktop/wake), then reads the session again. */
  wakeHome(): Promise<"awake" | "waking" | null>;
  setWaking(on: boolean): void;
  /** My Cloud's one-time code, or (`cloudId`) another Cloud of the person's own that the verified session lists, its
   * grant for that Cloud's own address only. Rejects with `gone: true` once that Cloud is no longer theirs. */
  pairHome(cloudId?: string | null): Promise<import("./cloud-home.mjs").CloudHomeGrant>;
  /** `origin` is a Cloud the person owns (My Cloud or another of theirs), by the verified session only. */
  isOwnCloud(origin: string | null | undefined): boolean;
  /** A new organization on the Team plan this account pays for (POST /api/cloud/desktop/organizations): no checkout. */
  addOrganization(input: { name: string; color?: import("./cloud-list.mjs").CloudSwatch | null }): Promise<OrganizationAddResult>;
  /** A Cloud's colour on the Admin (PATCH /api/cloud/desktop/clouds/:id), for its owner or its team's Super admin and Admins. */
  setCloudColor(cloudId: string, color: import("./cloud-list.mjs").CloudSwatch | null): Promise<{ outcome: "saved" | "refused" | "unsupported" | "failed" }>;
  /** Remove from list: one of the person's own Clouds the session says is `removable` leaves their list on the Admin. */
  hideCloud(cloudId: string): Promise<{ outcome: CloudRemoveOutcome }>;
  /** A one-time code for a team's Cloud, signed by the Admin with this person's membership (POST
   * /api/cloud/desktop/teams/<id>/pairing). Rejects with `gone: true` once they are no longer in the team. */
  pairTeam(teamId: string): Promise<import("./cloud-home.mjs").CloudHomeGrant>;
  /** A Cloud that ended and that the Admin still holds, started for its owner's export only. */
  exportHome(options?: { installation?: string }): Promise<{ starting: true } | { notHeld: true } | { deleted: true } | { grant: import("./cloud-home.mjs").CloudHomeGrant }>;
  /** Tells the Admin that this computer's move to My Cloud is done (POST /api/cloud/desktop/moved); false when it can't take it yet. */
  reportMove(options: { installation: string }): Promise<boolean>;
  /** This computer keeps its bots on itself again: it no longer counts as moved. False when the Admin can't take it yet. */
  reportKept(options: { installation: string }): Promise<boolean>;
  /** The Admin's word on this account's own Cloud at `origin` (POST /api/cloud/desktop/moved-to): deleted, ended (stopped and
   * kept only until it is deleted), live, or unknown (none of this account's). Null without a verified sign-in, or from an
   * Admin that doesn't say. */
  movedTo(origin: string): Promise<"deleted" | "ended" | "live" | "unknown" | null>;
  /** Tells the Admin where this computer's move to My Cloud stands (POST /api/cloud/desktop/move-status); false without a
   * sign-in or when the Admin doesn't take it yet. */
  reportMoveStatus(report: import("./move-status.mjs").MoveStatusReport): Promise<boolean>;
  growDisk(sizeGb: number): Promise<{ supported: false } | { supported: true; refused: true } | { supported: true; disk: { gb: number; maxGb: number } }>;
  /** This sign-in's own X research relay access while its plan is paid; null without one. */
  xResearchAccess(): Promise<{ url: string; token: string } | null>;
  pagesAccess(): Promise<{ url: string; token: string } | null>;
  /** GET /api/cloud/desktop/updates-consent, as the Admin answers it (updates-consent.mjs parseAccountConsent reads it). */
  /** No sign-in needed: returns the Admin's receipt for this email-only answer. */
  /** Another account takes over: nothing more is asked or written for this sign-in. */
  quiesce(): void;
  /** Reads the sign-in saved in `store` afresh, keeping nothing of the one before. */
  reload(): Promise<CloudAccountState>;
  /** Ends a sign-in that waits on this device, at the Admin. */
  revokeSaved(record: unknown): Promise<void>;
  close(): void;
}
export declare function createCloudAccountClient(options: {
  store: CloudAccountStore;
  openBrowser(url: string): Promise<unknown>;
  platform: string;
  deviceName: string;
  appVersion?: string;
  origin?: string;
  /** Enables HTTP loopback only for isolated fixtures. Production main never sets it. */
  fixture?: boolean;
  fetch?: typeof fetch;
  now?: () => number;
  onState?: (state: CloudAccountState) => void;
  /** Told once per plan name this app predates. Defaults to console.warn. */
  warn?: (message: string) => void;
  /** Files or lending waits for a sleeping Cloud to wake: the session is read every 15 s. */
  awaitingWake?: () => boolean;
  t?: (key: string, params?: Record<string, string | number>) => string;
}): CloudAccountClient;
export declare function cloudPlanSnapshot(state: CloudAccountState | null | undefined, extra?: { notice?: import("./cloud-home.mjs").CloudTrialState | null }): CloudPlanSnapshot;
/** My Cloud's line under its name in the server menus, or null for none. */
export declare function cloudMenuSublabel(state: CloudAccountState | null | undefined, date: (value: number) => string, t?: (key: string, params?: Record<string, string | number>) => string): string | null;
