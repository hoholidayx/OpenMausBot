import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CloudAccountState, CloudPlanSnapshot } from "../../electron/cloud-account.mjs";
import type { CloudCredit, CloudTrial } from "../../electron/cloud-home.mjs";
import { cloudCreditLine, cloudNoticeKind, cloudPlanLine, cloudPlanView, cloudTrialNotice, cloudTrialView, usd } from "./cloud-plan";
import { setLocale } from "./i18n";

const DAY = 86_400_000;
const ENDS = new Date(2026, 9, 15, 12).getTime();
const trial = (state: CloudTrial["state"], extra: Partial<CloudTrial> = {}): CloudTrial =>
  ({ state, tier: "pro", endsAt: ENDS, amount: 4900, chargeAt: null, holdUntil: null, deleteAt: null, keep: "none", ...extra });
const credit: CloudCredit = { grantedUsd: 5, remainingUsd: 3.2, state: "active" };

beforeEach(() => setLocale("en"));
afterEach(() => setLocale("en"));

describe("a free trial, in one message and at most one next step per state", () => {
  it("active: when it ends, what is charged and when, how to cancel, and nothing to do", () => {
    const view = cloudTrialView(trial("active", { chargeAt: ENDS }), credit);
    expect(view.title).toBe("Your free trial ends on Oct 15");
    expect(view.body).toBe("Then Pro is $49/month plus tax, charged on Oct 15. The Cloud keeps running, so there's nothing to do. To cancel, choose Manage subscription before then.");
    expect(view.credit).toBe("Includes $5 of Claude credit: $3.20 left.");
    expect(view.action).toEqual({ kind: "manage", label: "Manage subscription" });
    expect(view.body).toContain(view.action!.label);
    const unpriced = cloudTrialView(trial("active", { amount: null, tier: "max" }));
    expect(unpriced.body).toBe("Then Max is charged monthly, plus tax, from Oct 15. The Cloud keeps running, so there's nothing to do. To cancel, choose Manage subscription before then.");
    expect(unpriced.credit).toBeUndefined();
    expect(cloudTrialView(trial("active"), { ...credit, remainingUsd: 0, state: "used_up" }).credit).toBeUndefined();
    expect(cloudTrialView(trial("active", { tier: "team-2027" })).body).toContain("Then Cloud is $49/month");
    expect(cloudTrialView(trial("active", { tier: undefined })).body).toContain("Then your plan is $49/month");
    expect(cloudTrialView(trial("active", { amount: 5831 })).body).toContain("$58.31/month");
  });

  it("ending with renewal off: when it stops, when its files go, and Subscribe to keep it", () => {
    const view = cloudTrialView(trial("ending", { deleteAt: ENDS + 3 * DAY, keep: "portal" }), credit);
    expect(view).toEqual({ state: "ending", title: "Your free trial ends on Oct 15",
      body: "Renewal is off, so the Cloud stops then and its files are deleted on Oct 18.", action: null });
    expect(cloudTrialView(trial("ending", { keep: "portal" })).body).toBe("Renewal is off, so the Cloud stops then, and its files are deleted a few days later.");
  });

  it("cancelled outright before it ends: nothing to buy until it has stopped (a checkout now would stop the running Cloud)", () => {
    for (const keep of ["none", "checkout"] as const) {
      const view = cloudTrialView(trial("ending", { deleteAt: ENDS + 3 * DAY, keep }));
      expect(view.body, keep).toBe("Your subscription was cancelled. The Cloud stops then and its files are deleted on Oct 18.");
      expect(view.action, keep).toBeNull();
    }
  });

  it("processing, late and ended each say what happens to My Cloud and its files", () => {
    expect(cloudTrialView(trial("processing", { chargeAt: ENDS, holdUntil: ENDS + 3 * DAY }))).toEqual({ state: "processing",
      title: "Your first payment is processing", body: "The Cloud keeps running meanwhile, so there's nothing to do.", action: null });
    expect(cloudTrialView(trial("late", { deleteAt: ENDS + 6 * DAY, keep: "portal" }))).toEqual({ state: "late",
      title: "Your first payment is taking longer",
      body: "The Cloud is paused until it goes through, and comes back by itself. Its files are kept until Oct 21.",
      action: { kind: "status", label: "Check payment status" } });
    for (const keep of ["portal", "checkout"] as const) {
      expect(cloudTrialView(trial("ended", { deleteAt: ENDS + 3 * DAY, keep }))).toEqual({ state: "ended", title: "Your free trial has ended",
        body: "The Cloud is stopped. Its files are kept until Oct 18, then deleted.", action: null });
    }
    expect(cloudTrialView(trial("ended")).body).toBe("The Cloud is stopped, and its files are deleted soon.");
    expect(cloudTrialView(trial("late")).body).toBe("The Cloud is paused until it goes through, and comes back by itself.");
  });

  it("the notice shows only the state main says is due, never another or an older one", () => {
    const plan = (extra: Partial<CloudPlanSnapshot>): CloudPlanSnapshot => ({ status: "paid", tier: "pro", ...extra });
    expect(cloudTrialNotice(plan({ trial: trial("ending", { keep: "portal" }), notice: "ending" }))?.state).toBe("ending");
    expect(cloudTrialNotice(plan({ trial: trial("ending", { keep: "portal" }) }))).toBeNull();
    expect(cloudTrialNotice(plan({ trial: trial("processing"), notice: "active" }))).toBeNull();
    expect(cloudTrialNotice(plan({ notice: "ended" }))).toBeNull();
    expect(cloudTrialNotice(null)).toBeNull();
  });
});

describe("the plan line and the credit", () => {
  const connected = (extra: Partial<CloudAccountState>): CloudAccountState => ({ status: "connected", account: { id: "a", email: "person@example.test" },
    entitlement: { plan: "pro", tier: "pro", status: "active", expiresAt: ENDS + 3 * DAY, version: 1 }, ...extra });
  it("a running trial is a free trial, not an active paid plan; once paid, or ended, it is not", () => {
    for (const state of ["active", "ending", "processing"] as const) {
      expect(cloudPlanLine(cloudPlanView(connected({ trial: trial(state) })))).toBe("Pro free trial · verified by MausBot Cloud");
    }
    expect(cloudPlanLine(cloudPlanView(connected({})))).toBe("Pro active · verified by MausBot Cloud");
    expect(cloudPlanView(connected({ entitlement: { plan: "free", status: "inactive", expiresAt: null, version: 2 }, machine: { status: "stopped" }, trial: trial("ended") })).kind).toBe("attention");
  });

  it("says what is left, or that it is used up and what to do", () => {
    expect(cloudCreditLine(credit)).toBe("Trial Claude credit: $3.20 of $5 left. Cloud bots use it until you sign in there with your own Claude or ChatGPT account, or add an API key.");
    expect(cloudCreditLine({ grantedUsd: 5, remainingUsd: 0, state: "used_up" }))
      .toBe("Your $5 trial Claude credit is used up. To keep your bots working, sign in with your own Claude or ChatGPT account in the Cloud, or add an API key there.");
    expect([usd(5), usd(3.2), usd(0.004), usd(49), usd(58.31)]).toEqual(["$5", "$3.20", "$0", "$49", "$58.31"]);
  });


  it("a Personal subscriber's plan is Personal wherever the app names it", () => {
    const personal = { plan: "pro" as const, tier: "personal", expiresAt: ENDS + 3 * DAY, version: 1 };
    expect(cloudPlanLine(cloudPlanView(connected({ entitlement: { ...personal, status: "active" } })))).toBe("Personal active · verified by MausBot Cloud");
    expect(cloudPlanLine(cloudPlanView(connected({ entitlement: { ...personal, status: "inactive" } })))).toBe("Personal · not active right now");
    expect(cloudPlanLine(cloudPlanView({ status: "unavailable", lastPlan: { tier: "personal", active: true } }))).toBe("Personal · checking with MausBot Cloud…");
    expect(cloudPlanLine(cloudPlanView({ status: "reauth-required", message: "expired", lastPlan: { tier: "personal", active: true } }))).toBe("Personal plan");
    expect(cloudTrialView(trial("active", { tier: "personal", amount: 2900 })).body).toContain("Then Personal is $29/month plus tax");
  });

});


describe("This computer's Cloud sign-in card", () => {
  const view = (account: CloudAccountState) => cloudNoticeKind(cloudPlanView(account), account);
  it("says sign in again where the sign-in ended, and nothing to someone signed in", () => {
    const base = { status: "connected" as const, account: { id: "a", email: "p@example.test" } };
    const ready = { status: "ready" as const, origin: "https://omb-u-1.fly.dev" };
    expect(view({ ...base, entitlement: { plan: "pro", status: "active", expiresAt: ENDS + DAY, version: 1 }, machine: ready })).toBeNull();
    expect(view({ status: "reauth-required", message: "expired", lastPlan: { active: true } })).toBe("sign-in-again");
    expect(view({ status: "reauth-required", message: "expired", lastPlan: { active: false } })).toBeNull();
    expect(view({ status: "signed-out", message: "restore-removed" })).toBe("removed");
    expect(view({ status: "signed-out" })).toBeNull();
    expect(view({ ...base, entitlement: { plan: "free", status: "inactive", expiresAt: null, version: 1 } })).toBeNull();
  });
});


describe("an invited person with no Cloud of their own", () => {
  it("is offered no plan before their team: no trial card, no Start free trial in Settings", () => {
    const account = { status: "connected", account: { id: "u", email: "sam@acme.test" }, deviceId: "d", expiresAt: 1, entitlement: { plan: "free", status: "inactive", expiresAt: null, version: 1 },
      teams: [{ id: "t", name: "Acme", role: "member", machine: null }], landing: { teamId: "t" } } as never;
    expect(cloudPlanView(account)).toEqual({ kind: "free", invited: true });
  });
});
