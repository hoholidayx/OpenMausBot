import type { CloudAccountState, CloudPlanSnapshot } from "../../electron/cloud-account.mjs";
import type { CloudCredit, CloudTrial, CloudTrialState } from "../../electron/cloud-home.mjs";
import { activeLocale, t } from "@/lib/i18n";

const PLAN_LABEL: Record<string, string> = { starter: "Starter", personal: "Personal", pro: "Pro", max: "Max" };
export function cloudPlanLabel(tier?: string): string {
  return tier === undefined ? "Pro" : Object.hasOwn(PLAN_LABEL, tier) ? PLAN_LABEL[tier] : "Cloud";
}

export type CloudPlanView =
  | { kind: "unknown" }
  | { kind: "signed-out" }
  | { kind: "removed" }
  | { kind: "connecting" }
  | { kind: "free"; invited?: true }
  | { kind: "paid"; label: string; checking: boolean; trial?: true }
  | { kind: "attention"; label: string | null }
  | { kind: "purchase"; label: string | null; paidAt?: number }
  | { kind: "unverified"; label: string | null }
  | { kind: "reauth"; label: string | null; reason: "expired" | "access-ended" };

export function cloudPlanView(account: CloudAccountState | null | undefined): CloudPlanView {
  if (!account || (account.status === "signed-out" && account.message === "restoring")) return { kind: "unknown" };
  const last = account.lastPlan ? cloudPlanLabel(account.lastPlan.tier) : null;
  if (account.status === "signed-out") return account.message === "restore-removed" ? { kind: "removed" } : { kind: "signed-out" };
  if (account.status === "connecting") return { kind: "connecting" };
  if (account.status === "reauth-required") return { kind: "reauth", label: last, reason: account.message === "expired" ? "expired" : "access-ended" };
  if (account.status !== "connected") return { kind: "unverified", label: last };
  const entitlement = account.entitlement;
  if (entitlement?.plan === "pro" && entitlement.status === "active") {
    return { kind: "paid", label: cloudPlanLabel(entitlement.tier), checking: account.checking === true, ...(trialRunning(account.trial) ? { trial: true as const } : {}) };
  }
  if (account.purchase) {
    return { kind: "purchase", label: account.purchase.tier ? cloudPlanLabel(account.purchase.tier) : null, ...(account.purchase.paidAt ? { paidAt: account.purchase.paidAt } : {}) };
  }
  if (entitlement?.plan === "pro") return { kind: "attention", label: cloudPlanLabel(entitlement.tier) };
  if (account.machine) return { kind: "attention", label: null };
  // Invited into a team, with no Cloud of their own: their team comes first, and no plan is pushed at them.
  return account.landing ? { kind: "free", invited: true } : { kind: "free" };
}

export function cloudPlanLine(view: CloudPlanView): string | null {
  switch (view.kind) {
    case "paid": return t(view.trial ? "cloudAccount.trialPlan" : "cloudAccount.pro", { plan: view.label });
    case "attention": return t("cloudAccount.inactive", { plan: view.label ?? "MausBot Cloud" });
    case "purchase": return t("cloudAccount.purchaseReceived", { plan: view.label ?? "MausBot Cloud" });
    case "unverified": return view.label ? t("cloudAccount.lastPlan", { plan: view.label }) : null;
    case "reauth": return view.label ? t("cloudAccount.planName", { plan: view.label }) : null;
    case "free": return t("cloudAccount.free");
    default: return null;
  }
}

export function trialRunning(trial: CloudTrial | undefined): boolean {
  return trial?.state === "active" || trial?.state === "ending" || trial?.state === "processing";
}

const shortDate = (value: number) => new Intl.DateTimeFormat(activeLocale(), { day: "numeric", month: "short" }).format(new Date(value));

export function usd(dollars: number): string {
  const cents = Math.round(dollars * 100);
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100);
}

export type CloudTrialAction = "manage" | "status";
export interface CloudTrialView {
  state: CloudTrialState;
  title: string;
  body: string;
  credit?: string;
  action: { kind: CloudTrialAction; label: string } | null;
}

export function cloudTrialView(trial: CloudTrial, credit?: CloudCredit): CloudTrialView {
  const plan = trial.tier ? cloudPlanLabel(trial.tier) : t("cloudTrial.yourPlan");
  const ends = shortDate(trial.endsAt), deleted = trial.deleteAt ? shortDate(trial.deleteAt) : null;
  switch (trial.state) {
    case "active": return {
      state: "active", title: t("cloudTrial.endsOn", { date: ends }),
      body: trial.amount === null ? t("cloudTrial.activeNoPrice", { plan, date: shortDate(trial.chargeAt ?? trial.endsAt) })
        : t("cloudTrial.active", { plan, price: usd(trial.amount / 100), date: shortDate(trial.chargeAt ?? trial.endsAt) }),
      ...(credit?.state === "active" ? { credit: t("cloudTrial.credit", { granted: usd(credit.grantedUsd), left: usd(credit.remainingUsd) }) } : {}),
      action: { kind: "manage", label: t("cloudTrial.manage") },
    };
    case "ending": return trial.keep === "portal"
      ? { state: "ending", title: t("cloudTrial.endsOn", { date: ends }),
        body: deleted ? t("cloudTrial.ending", { date: deleted }) : t("cloudTrial.endingNoDate"), action: null }
      : { state: "ending", title: t("cloudTrial.endsOn", { date: ends }),
        body: deleted ? t("cloudTrial.cancelled", { date: deleted }) : t("cloudTrial.cancelledNoDate"), action: null };
    case "processing": return { state: "processing", title: t("cloudTrial.processingTitle"), body: t("cloudTrial.processing"), action: null };
    case "late": return { state: "late", title: t("cloudTrial.lateTitle"),
      body: deleted ? t("cloudTrial.late", { date: deleted }) : t("cloudTrial.lateNoDate"), action: { kind: "status", label: t("cloudTrial.checkPayment") } };
    case "ended": return { state: "ended", title: t("cloudTrial.endedTitle"),
      body: deleted ? t("cloudTrial.ended", { date: deleted }) : t("cloudTrial.endedNoDate"), action: null };
  }
}

export function cloudTrialNotice(plan: CloudPlanSnapshot | null | undefined): CloudTrialView | null {
  if (!plan?.notice || !plan.trial || plan.trial.state !== plan.notice) return null;
  return cloudTrialView(plan.trial, plan.credit);
}

export function cloudCreditLine(credit: CloudCredit): string {
  return credit.state === "used_up"
    ? t("cloudCredit.usedUp", { granted: usd(credit.grantedUsd) })
    : t("cloudCredit.left", { left: usd(credit.remainingUsd), granted: usd(credit.grantedUsd) });
}


export type CloudNoticeKind = "sign-in-again" | "removed";
export function cloudNoticeKind(view: CloudPlanView, account: CloudAccountState | null | undefined): CloudNoticeKind | null {
  if (view.kind === "reauth" && account?.lastPlan?.active === true) return "sign-in-again";
  if (view.kind === "removed") return "removed";
  return null;
}

/** The in-app sign-in's step, kept by the sheet: where it is and what the Admin last said, never a code or token. */
export type CloudSignInProblem = "invalid-email" | "rate-limited" | "failed" | "wrong-code" | "expired" | "signup-closed" | "device-limit" | "sso" | "two-factor" | "browser";
export type CloudSignInPhase =
  | { step: "email"; intent: boolean; problem: CloudSignInProblem | null }
  | { step: "code"; intent: boolean; email: string; resendAt: number; problem: CloudSignInProblem | null; triesLeft: number | null; signupOpen?: boolean }
  | { step: "done"; intent: boolean };
