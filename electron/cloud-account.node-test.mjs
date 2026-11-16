import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nativeText from "./native-text.cjs";
import { accessToken, fixture, until } from "./fixtures/cloud-account.mjs";
import { cancelSurvey, cloudMenuSublabel, createCloudAccountStore, cloudOrigin, cloudPlanSnapshot, CLOUD_ORIGIN } from "./cloud-account.mjs";


test("Cloud origin is fixed; only explicit fixtures can use loopback", () => {
  assert.equal(cloudOrigin(), CLOUD_ORIGIN);
  for (const value of ["https://attacker.example.test", "http://127.0.0.1:1234", `${CLOUD_ORIGIN}/`, `${CLOUD_ORIGIN}/?paid=true`]) assert.throws(() => cloudOrigin(value));
  assert.equal(cloudOrigin("http://127.0.0.1:1234", true), "http://127.0.0.1:1234");
  assert.throws(() => cloudOrigin("https://attacker.example.test", true));
});

test("fresh startup stays local with no enrollment, browser, or network; explicit sign-in uses private polling", async t => {
  const f = await fixture(t);
  assert.equal((await f.client.start()).status, "signed-out"); assert.deepEqual(f.requests, []); assert.deepEqual(f.browsers, []);
  await f.client.begin("https://attacker.example.test");
  assert.equal(f.browsers[0], `${f.origin}/cloud/desktop?code=ABCDE-FGHJK`);
  assert.equal(f.client.state().enrollment.userCode, "ABCDE-FGHJK");
  f.approved = true; f.tick(); await until(() => f.client.state().status === "connected");
  assert.equal(f.saved.token, accessToken); assert.equal(f.saved.entitlement, undefined);
  assert.equal(f.client.state().entitlement.plan, "free");
  assert.ok(!JSON.stringify(f.states).includes(accessToken)); assert.ok(!JSON.stringify(f.states).includes("A".repeat(43)));
  assert.equal(f.requests.find(row => row.route.endsWith("/session")).token, `Bearer ${accessToken}`);
});

test("a browser return cannot activate Pro; only refreshed server state can, and revocation removes it", async t => {
  const f = await fixture(t); await f.connect();
  await f.client.openDashboard("https://attacker.example.test?paid=true");
  assert.equal(f.browsers.at(-1), `${f.origin}/cloud`); assert.equal(f.client.state().entitlement.plan, "free");
  f.entitlement = { plan: "pro", status: "active", expiresAt: f.now + 3600_000, version: 1 };
  assert.equal(f.client.state().entitlement.plan, "free");
  assert.equal((await f.client.refresh()).entitlement.plan, "pro");
  f.revoked = true;
  assert.equal((await f.client.refresh()).status, "reauth-required"); assert.equal(f.client.state().entitlement, undefined);
});

test("a failed check keeps the last verified answer (never a malformed one), says so quietly, and changed identity ends access", async t => {
  const f = await fixture(t); await f.connect();
  const paid = { plan: "pro", tier: "max", status: "active", expiresAt: f.now + 3 * 3600_000, version: 1 };
  f.entitlement = paid; await f.client.refresh(); f.sessionStatus = 503;
  let state = await f.client.refresh();
  assert.equal(state.status, "connected"); assert.deepEqual(state.entitlement, paid); assert.equal(state.checking, undefined); assert.equal(f.saved.token, accessToken);
  state = await f.client.refresh();
  assert.equal(state.status, "connected"); assert.deepEqual(state.entitlement, paid); assert.equal(state.checking, true);
  f.sessionStatus = 200; f.invalidEntitlement = true;
  state = await f.client.refresh(); assert.equal(state.status, "connected"); assert.deepEqual(state.entitlement, paid);
  f.invalidEntitlement = false; state = await f.client.refresh(); assert.equal(state.checking, undefined); assert.deepEqual(state.entitlement, paid);
  f.sessionStatus = 503; await f.client.refresh(); f.now += 15 * 60_000;
  state = f.client.state(); assert.equal(state.status, "unavailable"); assert.equal(state.entitlement, undefined); assert.deepEqual(state.lastPlan, { tier: "max", active: true });
  f.sessionStatus = 200; f.invalidIdentity = true;
  state = await f.client.refresh(); assert.equal(state.status, "reauth-required"); assert.equal(state.message, "access-ended"); assert.equal(state.entitlement, undefined);
  assert.deepEqual(state.lastPlan, { tier: "max", active: true });
});

test("a check that fails is asked again after 15 s, 30 s, then each minute", async t => {
  const f = await fixture(t); await f.connect();
  f.sessionStatus = 503; await f.client.refresh(); assert.equal(f.delay, 15_000);
  for (const delay of [30_000, 60_000, 60_000]) { f.tick(); await until(() => f.timer); assert.equal(f.delay, delay); }
  f.sessionStatus = 200; f.tick(); await until(() => f.timer);
  f.sessionStatus = 503; f.tick(); await until(() => f.timer);
  assert.equal(f.delay, 15_000, "an answer starts the count again");
});

test("a successful re-check never shows anything but the verified plan, and runs well before the answer stops counting", async t => {
  const f = await fixture(t); await f.connect();
  f.entitlement = { plan: "pro", status: "active", expiresAt: f.now + 3 * 3600_000, version: 1 };
  await f.client.refresh();
  assert.ok(f.delay <= 60_000, "next check within a minute");
  assert.ok(f.client.state().verifiedUntil - f.now >= 10 * 60_000, "the answer counts for several checks");
  const before = f.states.length;
  for (let i = 0; i < 3; i++) { f.now += f.delay; f.tick(); await until(() => f.states.length > before + i); }
  assert.deepEqual(f.states.slice(before).map(state => `${state.status}:${state.entitlement?.plan}`), ["connected:pro", "connected:pro", "connected:pro"]);
});

test("while the Cloud is set up, or a payment is being linked, progress is asked for every 15 seconds", async t => {
  const f = await fixture(t); await f.connect();
  f.entitlement = { plan: "pro", status: "active", expiresAt: f.now + 3 * 3600_000, version: 1 };
  f.cloud = { state: "setting_up", setup: { step: "storage", slow: true } };
  let state = await f.client.refresh();
  assert.deepEqual(state.machine, { status: "provisioning", setup: { step: "storage", slow: true } }); assert.equal(f.delay, 15_000);
  f.cloud = null; await f.client.refresh(); assert.equal(f.delay, 15_000, "paid with no Cloud listed yet: setting up");
  f.cloud = { state: "ready", origin: "https://home-7f3k2.fly.dev", disk: { gb: 20, maxGb: 100 } };
  state = await f.client.refresh(); assert.deepEqual(state.machine.disk, { gb: 20, maxGb: 100 }); assert.equal(f.delay, 60_000);
  f.entitlement = { plan: "free", status: "inactive", expiresAt: null, version: 2 };
  f.cloud = { purchase: { state: "confirming", plan: "personal", paidAt: f.now - 60_000 } };
  state = await f.client.refresh();
  assert.deepEqual(state.purchase, { state: "confirming", tier: "personal", paidAt: f.now - 60_000 }); assert.equal(state.entitlement.plan, "free"); assert.equal(f.delay, 15_000);
});

test("a Team plan's Cloud is its team's: its setup is followed every 15 seconds, then the session every minute, never waiting on a My Cloud", async t => {
  const f = await fixture(t); await f.connect();
  f.entitlement = { plan: "pro", tier: "team", status: "active", expiresAt: f.now + 3 * 3600_000, version: 1 };
  const team = machine => [{ id: "team-acme", name: "Acme", role: "owner", machine }];
  f.teams = team({ state: "setting_up", origin: null, pairingAvailable: false, setup: { step: "storage" } });
  let state = await f.client.refresh();
  assert.deepEqual(state.teams[0].machine, { status: "provisioning", setup: { step: "storage" } }); assert.equal(f.delay, 15_000);
  f.teams = team({ state: "ready", status: "ready", origin: "https://omb-t-2.fly.dev", pairingAvailable: true });
  state = await f.client.refresh();
  assert.equal(state.machine, undefined); assert.equal(f.delay, 60_000, "the team's Cloud is ready: nothing is being set up");
  f.teams = undefined; await f.client.refresh(); assert.equal(f.delay, 15_000, "no team listed yet: its setup");
});

test("a connection that fails while the Admin says My Cloud can't be reached says why, from the Admin's latest word; otherwise the request's own error", async t => {
  const f = await fixture(t); await f.connect();
  const origin = "https://home-7f3k2.fly.dev", since = f.now - 6 * 60_000;
  f.entitlement = { plan: "pro", tier: "pro", status: "active", expiresAt: f.now + 86_400_000, version: 1 };
  f.cloud = { state: "ready", origin, pairingAvailable: true };
  await f.client.refresh();
  // The Admin can't make a connection code here (the fixture has no pairing route), and says nothing about why.
  await assert.rejects(f.client.pairHome(), { message: "Cloud request failed." });
  // Its health checks found the server down since this app last read the session: the app reads it again and says why.
  f.cloud = { state: "ready", origin, pairingAvailable: true, unreachable: { cause: "host", since } };
  await assert.rejects(f.client.pairHome(), { message: "The server My Cloud runs on is being restarted by our hosting provider. My Cloud and its files are safe, and it comes back on its own, usually within about 20 minutes." });
  assert.deepEqual(f.client.state().machine, { status: "ready", origin, unreachable: { cause: "host", since } });
  f.cloud = { ...f.cloud, unreachable: { cause: "no_answer", since } };
  await assert.rejects(f.client.pairHome(), { message: "My Cloud hasn't answered for a few minutes. Nothing was lost, and we've been told." });
  f.cloud = { state: "ready", origin, pairingAvailable: true };
  await assert.rejects(f.client.pairHome(), { message: "Cloud request failed." });
});

test("a free trial and its AI credit come with a verified session, for display only; an Admin without them changes nothing", async t => {
  const f = await fixture(t); await f.connect();
  const DAY = 86_400_000, endsAt = f.now + 2 * DAY, origin = "https://home-7f3k2.fly.dev";
  const trial = { state: "active", tier: "pro", endsAt, amount: 4900, chargeAt: endsAt, holdUntil: null, deleteAt: null, keep: "none" };
  const credit = { grantedUsd: 5, remainingUsd: 3.2, state: "active" };
  f.entitlement = { plan: "pro", tier: "pro", status: "active", expiresAt: endsAt + 3 * DAY, version: 1 };
  f.cloud = { state: "ready", origin, pairingAvailable: true };
  let state = await f.client.refresh();
  assert.equal(state.trial, undefined); assert.equal(state.credit, undefined);
  assert.deepEqual(cloudPlanSnapshot(state), { status: "paid", tier: "pro" });
  f.cloud = { state: "ready", origin, pairingAvailable: true, trial, credit };
  state = await f.client.refresh();
  assert.deepEqual(state.trial, trial); assert.deepEqual(state.credit, credit); assert.deepEqual(state.machine, { status: "ready", origin });
  assert.equal(state.entitlement.status, "active", "the trial grants nothing; the entitlement does");
  assert.ok(!JSON.stringify(f.saved).includes("trial") && !JSON.stringify(f.saved).includes("credit"), "nothing about a trial is kept beside the sign-in");
  const snapshot = cloudPlanSnapshot(state, { notice: "active" });
  assert.deepEqual(snapshot, { status: "paid", tier: "pro", trial, credit, notice: "active" });
  assert.ok(!JSON.stringify(snapshot).includes("person@example.test") && !JSON.stringify(snapshot).includes("fixture-account"));
  f.cloud = { state: "ready", origin, pairingAvailable: true, trial: { ...trial, state: "paused" }, credit: { ...credit, remainingUsd: 9 } };
  state = await f.client.refresh();
  assert.equal(state.trial, undefined); assert.equal(state.credit, undefined); assert.equal(state.machine.status, "ready"); assert.equal(state.entitlement.status, "active");
  const ended = { ...trial, state: "ended", chargeAt: null, deleteAt: endsAt + 3 * DAY, keep: "checkout" };
  f.entitlement = { plan: "free", status: "inactive", expiresAt: null, version: 2 };
  f.cloud = { state: "stopped", origin: null, pairingAvailable: false, trial: ended };
  state = await f.client.refresh();
  assert.deepEqual(cloudPlanSnapshot(state, { notice: "ended" }), { status: "none", trial: ended, notice: "ended" });
  f.sessionStatus = 503; await f.client.refresh(); f.now += 15 * 60_000;
  assert.equal(f.client.state().trial, undefined);
  assert.deepEqual(cloudPlanSnapshot(f.client.state(), { notice: "ended" }), { status: "none" });
  for (const unverified of [{ status: "unavailable", trial: ended, credit, lastPlan: { tier: "pro", active: true } }, { status: "unavailable", trial: ended, credit },
    { status: "reauth-required", trial: ended, credit }, { status: "signed-out", trial: ended }]) {
    const shown = cloudPlanSnapshot(unverified, { notice: "ended" });
    assert.equal(shown.trial, undefined); assert.equal(shown.credit, undefined); assert.equal(shown.notice, undefined);
  }
  assert.deepEqual(cloudPlanSnapshot({ status: "connected", entitlement: { plan: "free", status: "inactive", expiresAt: null, version: 1 } }, { notice: "ended" }), { status: "none" });
});








test("this app's version rides on every signed-in request", async t => {
  const f = await fixture(t); await f.connect();
  assert.equal(JSON.parse(f.requests.find(row => row.route.endsWith("/authorize")).body).appVersion, "0.1.fixture");
  assert.ok(f.requests.filter(row => row.route.endsWith("/session")).every(row => row.version === "0.1.fixture"));
  assert.ok(f.requests.filter(row => !row.token).every(row => row.version === undefined), "never on a request without the sign-in");
});

test("active Pro requires a future expiry and free+active is never accepted", async t => {
  const f = await fixture(t); await f.connect();
  const free = f.client.state().entitlement;
  for (const invalid of [
    { plan: "pro", status: "active", expiresAt: null, version: 1 },
    { plan: "pro", status: "active", expiresAt: f.now, version: 1 },
    { plan: "free", status: "active", expiresAt: f.now + 3600_000, version: 1 },
  ]) {
    f.entitlement = invalid; const state = await f.client.refresh();
    assert.equal(state.status, "connected"); assert.deepEqual(state.entitlement, free);
  }
  f.now += 15 * 60_000; assert.equal(f.client.state().status, "unavailable"); assert.equal(f.client.state().entitlement, undefined);
});

test("a tier names the paid plan; a missing, unknown or malformed tier never rejects or downgrades it", async t => {
  const warnings = [], f = await fixture(t, { warn: message => warnings.push(message) }); await f.connect();
  const paid = { plan: "pro", status: "active", expiresAt: f.now + 3600_000, version: 1 };
  f.entitlement = paid; assert.deepEqual((await f.client.refresh()).entitlement, paid);
  for (const tier of ["personal", "pro", "max", "team-2026"]) {
    f.entitlement = { ...paid, tier }; assert.deepEqual((await f.client.refresh()).entitlement, { ...paid, tier });
  }
  for (const tier of ["Max", "", "max\n", "2x", "-max", "m".repeat(25), 5, null, {}, ["max"]]) {
    f.entitlement = { ...paid, tier }; const state = await f.client.refresh();
    assert.equal(state.status, "connected"); assert.deepEqual(state.entitlement, paid);
  }
  f.entitlement = { plan: "free", status: "inactive", expiresAt: null, version: 2, tier: "Bad tier" };
  assert.deepEqual((await f.client.refresh()).entitlement, { plan: "free", status: "inactive", expiresAt: null, version: 2 });
  assert.deepEqual(warnings, []);
});

test("a plan newer than the app (personal, max) is paid with that tier, told once, never a lockout", async t => {
  const warnings = [], f = await fixture(t, { warn: message => warnings.push(message) }); await f.connect();
  const paid = { status: "active", expiresAt: f.now + 3600_000, version: 1 };
  f.entitlement = { plan: "max", ...paid };
  assert.deepEqual((await f.client.refresh()).entitlement, { plan: "pro", tier: "max", ...paid });
  await f.client.refresh(); assert.equal(warnings.length, 1); assert.match(warnings[0], /"max"/);
  f.entitlement = { plan: "personal", ...paid, tier: "personal" };
  assert.deepEqual((await f.client.refresh()).entitlement, { plan: "pro", tier: "personal", ...paid }); assert.equal(warnings.length, 2);
  f.entitlement = { plan: "max", ...paid, tier: "Bad" };
  assert.deepEqual((await f.client.refresh()).entitlement, { plan: "pro", tier: "max", ...paid });
  f.entitlement = { plan: "max", status: "inactive", expiresAt: f.now - 1, version: 2 };
  assert.deepEqual((await f.client.refresh()).entitlement, { plan: "pro", tier: "max", status: "inactive", expiresAt: f.now - 1, version: 2 });
  assert.equal(warnings.length, 2);
  const kept = f.client.state().entitlement;
  for (const invalid of [{ plan: "max", status: "active", expiresAt: null, version: 1 }, { plan: "max", status: "active", expiresAt: f.now, version: 1 },
    ...["Max", "", "pro ", "m".repeat(25), 5, null].map(plan => ({ plan, ...paid }))]) {
    f.entitlement = invalid; assert.deepEqual((await f.client.refresh()).entitlement, kept);
  }
});

test("a verified answer stops counting at the plan's own expiry or after 15 minutes without a check; cached Pro is never restored", async t => {
  const f = await fixture(t); await f.connect(); f.entitlement = { plan: "pro", status: "active", expiresAt: f.now + 2000, version: 1 };
  await f.client.refresh(); f.now += 2001;
  assert.equal(f.client.state().status, "unavailable"); assert.equal(f.client.state().entitlement, undefined);
  assert.deepEqual(f.client.state().lastPlan, { active: true }, "the plan is still named while it is checked");
  await f.client.refresh(); assert.equal(f.client.state().status, "unavailable");
  f.entitlement = { plan: "pro", status: "inactive", expiresAt: f.now - 1, version: 2 };
  await f.client.refresh(); assert.equal(f.client.state().entitlement.status, "inactive");
  f.now += 15 * 60_000 - 1; assert.equal(f.client.state().entitlement.status, "inactive");
  f.now += 1; assert.equal(f.client.state().entitlement, undefined);
  f.saved.entitlement = { plan: "pro", status: "active", expiresAt: null, version: 999 }; f.sessionStatus = 503;
  await f.client.start(); assert.equal(f.client.state().entitlement, undefined); assert.equal(f.client.state().status, "unavailable");
});

test("the plan hint is saved for display only, follows the verified plan, and is gone with the sign-in", async t => {
  const f = await fixture(t); await f.connect();
  assert.equal(f.saved.planHint, undefined, "a free account saves no plan");
  f.entitlement = { plan: "pro", tier: "personal", status: "active", expiresAt: f.now + 3600_000, version: 1 };
  await f.client.refresh(); assert.deepEqual(f.saved.planHint, { tier: "personal", active: true }); assert.equal(f.saved.entitlement, undefined);
  f.sessionStatus = 503; f.client.close();
  const restored = await fixture(t); restored.saved = { ...f.saved, origin: restored.origin }; restored.sessionStatus = 503;
  const state = await restored.client.start();
  assert.equal(state.status, "unavailable"); assert.equal(state.entitlement, undefined); assert.deepEqual(state.lastPlan, { tier: "personal", active: true });
  const odd = await fixture(t); odd.saved = { ...f.saved, origin: odd.origin, planHint: { tier: "<b>", active: "yes" } }; odd.sessionStatus = 503;
  assert.equal((await odd.client.start()).lastPlan, undefined);
  restored.sessionStatus = 200; restored.entitlement = { plan: "free", status: "inactive", expiresAt: null, version: 2 };
  await restored.client.refresh(); assert.equal(restored.saved.planHint, undefined);
  await restored.client.signOut(); assert.equal(restored.saved, null); assert.equal(restored.client.state().lastPlan, undefined);
});

test("before a saved sign-in is read, nobody is signed out; with none, signed out plainly", async t => {
  const f = await fixture(t);
  assert.deepEqual(f.client.state(), { status: "signed-out", message: "restoring" });
  assert.deepEqual(await f.client.start(), { status: "signed-out" });
});

test("a sign-in that reached its end asks to sign in again, keeps the plan, and starts the new one without showing signed out", async t => {
  const f = await fixture(t); await f.connect();
  f.entitlement = { plan: "pro", tier: "max", status: "active", expiresAt: f.now + 40 * 86400_000, version: 1 };
  await f.client.refresh();
  await assert.rejects(f.client.signInAgain(), /still signed in/);
  f.now += 86400_000 + 1;
  assert.equal(f.client.state().status, "reauth-required"); assert.equal(f.client.state().message, "expired");
  const ended = await f.client.refresh();
  assert.equal(ended.status, "reauth-required"); assert.equal(ended.message, "expired"); assert.deepEqual(ended.lastPlan, { tier: "max", active: true });
  assert.equal(ended.entitlement, undefined);
  const before = f.states.length, browsers = f.browsers.length;
  const next = await f.client.signInAgain();
  assert.equal(next.status, "connecting"); assert.equal(next.enrollment.userCode, "ABCDE-FGHJK");
  assert.ok(f.states.slice(before).every(state => state.status === "connecting"), "never signed out in between");
  assert.equal(f.browsers.length, browsers + 1); assert.equal(f.saved, null);
  f.revoked = false; f.tick(); await until(() => f.client.state().status === "connected");
  assert.equal(f.saved.token, accessToken);
});

test("the sign-in code may last up to 30 minutes, no longer", async t => {
  const f = await fixture(t); f.expiresIn = 900;
  const state = await f.client.begin(); assert.equal(state.enrollment.expiresAt, f.now + 900_000);
  await f.client.cancel();
  const g = await fixture(t); g.expiresIn = 1801;
  assert.equal((await g.client.begin()).message, "signin-failed");
});

test("only the Admin's own answer ends a sign-in: a 401/403 page from in between is a failed check", async t => {
  const f = await fixture(t); await f.connect();
  const paid = { plan: "pro", tier: "max", status: "active", expiresAt: f.now + 3 * 3600_000, version: 1 };
  f.entitlement = paid; await f.client.refresh();
  // A firewall or bot-check page (Cloudflare serves cloud.openmausbot.com).
  f.sessionPage = 403;
  let state = await f.client.refresh();
  assert.equal(state.status, "connected"); assert.deepEqual(state.entitlement, paid); assert.equal(state.checking, undefined);
  f.sessionPage = 401; state = await f.client.refresh();
  assert.equal(state.status, "connected"); assert.equal(state.checking, true); assert.equal(f.saved.token, accessToken);
  f.sessionPage = null; f.sessionError = { status: 403, body: { error: "invalid_origin" } };
  state = await f.client.refresh(); assert.equal(state.status, "connected"); assert.deepEqual(state.entitlement, paid);
  f.sessionError = { status: 401, body: { error: "invalid_token" } };
  state = await f.client.refresh(); assert.equal(state.status, "reauth-required"); assert.equal(state.message, "access-ended");
  assert.deepEqual(state.lastPlan, { tier: "max", active: true });
  assert.ok(!f.requests.some(row => row.method === "DELETE"));
});

test("a page from in between during sign-in keeps waiting for the approval", async t => {
  const f = await fixture(t);
  await f.client.begin();
  f.tokenPage = 403; f.tick();
  await until(() => f.requests.some(row => row.route.endsWith("/token")) && f.timer);
  assert.equal(f.client.state().status, "connecting"); assert.equal(f.client.state().enrollment.userCode, "ABCDE-FGHJK");
  f.tokenPage = null; f.approved = true; f.tick();
  await until(() => f.client.state().status === "connected");
});

test("growing the Cloud's disk: an Admin without it says so, a size over the plan is refused, and a grown disk is reported", async t => {
  const f = await fixture(t);
  await assert.rejects(f.client.growDisk(20), /not ready/);
  await f.connect();
  assert.deepEqual(await f.client.growDisk(20), { supported: false });
  f.disk = { status: 405, body: { error: "method" } }; assert.deepEqual(await f.client.growDisk(20), { supported: false });
  f.disk = { status: 422, body: { error: "over the plan's disk" } }; assert.deepEqual(await f.client.growDisk(200), { supported: true, refused: true });
  f.disk = { status: 200, body: { disk: { gb: 20, maxGb: 100 } } }; assert.deepEqual(await f.client.growDisk(20), { supported: true, disk: { gb: 20, maxGb: 100 } });
  f.disk = { status: 200, body: { disk: { gb: 0, maxGb: 100 } } }; await assert.rejects(f.client.growDisk(20), /Invalid/);
  f.disk = { status: 500, body: { error: "down" } }; await assert.rejects(f.client.growDisk(20));
  await assert.rejects(f.client.growDisk(0), /Invalid/);
  const body = JSON.parse(f.requests.filter(row => row.route.endsWith("/disk")).at(-1).body);
  assert.deepEqual(body, { sizeGb: 20 });
});

test("sign-out durably forgets personal Cloud and revokes only its credential; offline revocation is disclosed", async t => {
  const f = await fixture(t); await f.connect();
  const signedOut = await f.client.signOut();
  assert.equal(signedOut.status, "signed-out"); assert.equal(f.saved, null); assert.equal(f.revoked, true);
  assert.equal(f.requests.filter(row => row.method === "DELETE").length, 1);
  assert.ok(f.requests.every(row => row.route.startsWith("/api/cloud/desktop/")));
  f.revoked = false; await f.connect(); f.sessionStatus = 503;
  assert.equal((await f.client.signOut()).message, "signout-local-only"); assert.equal(f.saved, null);
  f.sessionStatus = 200; await f.connect(); f.sessionPage = 403;
  assert.equal((await f.client.signOut()).message, "signout-local-only"); assert.equal(f.revoked, false);
});

test("failed durable sign-out blocks reconnect until cleanup succeeds", async t => {
  const f = await fixture(t); await f.connect(); f.failWrite = true;
  assert.equal((await f.client.signOut()).message, "signout-storage-failed");
  await assert.rejects(f.client.begin(), /Sign out/); assert.equal(f.client.state().entitlement, undefined);
  f.failWrite = false; await f.client.signOut(); assert.equal(f.saved, null);
});

test("startup restoration cannot race a new sign-in, and failed token persistence revokes the issued credential", async t => {
  let resolveRead;
  const f = await fixture(t, { store: { read: () => new Promise(resolve => { resolveRead = resolve; }), write: async () => {} } });
  const restoring = f.client.start(); await assert.rejects(f.client.begin(), /Sign out/);
  resolveRead(null); await restoring; assert.deepEqual(f.requests, []);
  const broken = await fixture(t); broken.failWrite = true; await broken.client.begin(); broken.approved = true; broken.tick();
  await until(() => broken.revoked); await until(() => broken.client.state().message === "signout-storage-failed");
  assert.equal(broken.client.state().entitlement, undefined); assert.equal(broken.saved, null);
});

test("invalid browser URLs are refused and cancellation cannot persist a late issued token", async t => {
  const f = await fixture(t, { fetch: (url, options) => fetch(url, { ...options, signal: undefined }) });
  f.badUrl = true; assert.equal((await f.client.begin()).status, "signed-out"); assert.deepEqual(f.browsers, []);
  f.badUrl = false; await f.client.begin(); f.approved = true;
  let release; f.slowToken = new Promise(resolve => { release = resolve; }); f.tick();
  await until(() => f.requests.some(row => row.route.endsWith("/token")));
  await f.client.cancel(); release(); await until(() => f.revoked);
  assert.equal(f.saved, null); assert.equal(f.client.state().status, "signed-out");
  await f.client.reopen(); assert.equal(f.browsers.length, 1);
});

test("Cloud records use separate encrypted atomic storage, not plaintext or saved entitlements", async t => {
  const directory = await mkdtemp(join(tmpdir(), "omb-cloud-record-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "cloud-account.bin"); let unlocked = true;
  // The fixture substitutes encryption; it does not use the user's keychain.
  const store = createCloudAccountStore({ file, encryption: { available: async () => unlocked,
    encrypt: value => Buffer.from(value).map(byte => byte ^ 0x55), decrypt: value => Buffer.from(value).map(byte => byte ^ 0x55).toString() } });
  await store.write({ token: accessToken }); assert.deepEqual(await store.read(), { token: accessToken });
  assert.ok(!(await readFile(file)).toString().includes(accessToken));
  unlocked = false; await assert.rejects(store.read()); await store.write(null); assert.equal(await store.read(), null);
});

test("a saved Cloud sign-in is read back after a restart with Electron 43's decrypt shape ({ shouldReEncrypt, result })", async t => {
  const directory = await mkdtemp(join(tmpdir(), "omb-cloud-electron43-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "cloud-account.bin");
  // Exactly what safeStorage.decryptStringAsync resolves to in Electron 43, not a bare string.
  const electron43 = { available: async () => true, encrypt: async value => Buffer.from(value).map(byte => byte ^ 0x55),
    decrypt: async value => ({ shouldReEncrypt: false, result: Buffer.from(value).map(byte => byte ^ 0x55).toString() }) };
  await createCloudAccountStore({ file, encryption: electron43 }).write({ token: accessToken });
  // A new store over the same file stands in for the next app launch.
  assert.deepEqual(await createCloudAccountStore({ file, encryption: electron43 }).read(), { token: accessToken });
});

/** Electron 43's safeStorage shape over a one-byte key. `lock.locked` stands in for a locked keychain. */
const electron43Store = (file, lock = { locked: false }, decrypt) => createCloudAccountStore({ file, encryption: { available: async () => !lock.locked,
  encrypt: async value => Buffer.from(value).map(byte => byte ^ 0x55),
  decrypt: decrypt ?? (async value => ({ shouldReEncrypt: false, result: Buffer.from(value).map(byte => byte ^ 0x55).toString() })) } });
const savedSignIn = f => ({ origin: f.origin, token: accessToken, expiresAt: f.now + 86400_000, device: { id: "fixture-device" }, account: { id: "fixture-account", email: "person@example.test" } });

test("a saved Cloud sign-in that can never be read is removed, and signing in again is the one next step", async t => {
  const directory = await mkdtemp(join(tmpdir(), "omb-cloud-unreadable-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "cloud-account.bin");
  for (const decrypt of [
    // This computer's key no longer opens it (Windows after a reinstall onto a new profile).
    async () => { throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptString."); },
    async () => ({ shouldReEncrypt: false, result: "not json" }),
    async () => ({ shouldReEncrypt: false, result: JSON.stringify({ token: "not-a-cloud-token" }) }),
  ]) {
    const f = await fixture(t, { store: electron43Store(file, undefined, decrypt) });
    await electron43Store(file).write(savedSignIn(f));
    assert.deepEqual(await f.client.start(), { status: "signed-out", message: "restore-removed" });
    await assert.rejects(stat(file), { code: "ENOENT" });
    assert.equal(f.timer, null, "nothing is read again");
    assert.equal((await f.client.begin()).status, "connecting");
  }
});

test("a locked keychain never removes the saved Cloud sign-in: it is read again, sooner then each minute, until it opens", async t => {
  const directory = await mkdtemp(join(tmpdir(), "omb-cloud-locked-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "cloud-account.bin"), lock = { locked: false };
  const f = await fixture(t, { store: electron43Store(file, lock) });
  await electron43Store(file).write(savedSignIn(f));
  lock.locked = true;
  assert.deepEqual(await f.client.start(), { status: "unavailable", message: "restore-failed" });
  assert.equal(f.delay, 15_000);
  await assert.rejects(f.client.begin(), /Sign out/);
  for (const delay of [30_000, 60_000, 60_000]) { f.tick(); await until(() => f.timer); assert.equal(f.delay, delay); }
  assert.ok((await stat(file)).isFile(), "a locked sign-in is never removed");
  assert.equal(f.states.filter(state => state.message === "restore-failed").length, 1, "said once, not on every try");
  lock.locked = false; f.tick();
  await until(() => f.client.state().status === "connected");
  assert.equal(f.client.state().account.email, "person@example.test");
});

test("a decrypt answer in a shape this app does not know is never taken for an unreadable sign-in", async t => {
  const directory = await mkdtemp(join(tmpdir(), "omb-cloud-shape-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "cloud-account.bin");
  const f = await fixture(t, { store: electron43Store(file, undefined, async () => ({ shouldReEncrypt: false })) });
  await electron43Store(file).write(savedSignIn(f));
  assert.deepEqual(await f.client.start(), { status: "unavailable", message: "restore-failed" });
  assert.ok((await stat(file)).isFile());
});

test("cancelling during the encrypted write queues deletion after it and cannot restore the grant", async t => {
  const directory = await mkdtemp(join(tmpdir(), "omb-cloud-cancel-")); t.after(() => rm(directory, { recursive: true, force: true }));
  let release, writing = false; const gate = new Promise(resolve => { release = resolve; });
  const store = createCloudAccountStore({ file: join(directory, "cloud-account.bin"), encryption: { available: async () => true,
    encrypt: async value => { writing = true; await gate; return Buffer.from(value); }, decrypt: value => value.toString() } });
  const f = await fixture(t, { store }); await f.client.begin(); f.approved = true; f.tick(); await until(() => writing);
  const cancellation = f.client.cancel(); release(); await cancellation; await until(() => f.revoked);
  assert.equal(await store.read(), null); assert.equal(f.client.state().status, "signed-out"); assert.equal(f.client.state().entitlement, undefined);
});

test("X research access: this sign-in's own relay token, null without a plan or the service, never a URL off the Cloud's origin", async t => {
  const f = await fixture(t);
  const before = f.requests.length;
  assert.equal(await f.client.xResearchAccess(), null);
  assert.equal(f.requests.length, before);
  await f.connect();
  const token = `omb_xd_${"a".repeat(43)}`, url = `${f.origin}/api/cloud/services/x`;
  f.x = { status: 200, body: { cloudContractVersion: 1, url, token } };
  assert.deepEqual(await f.client.xResearchAccess(), { url, token });
  assert.ok(f.requests.some(r => r.route === "/api/cloud/desktop/services/x" && r.method === "POST" && r.token === `Bearer ${accessToken}`));
  f.x = { status: 402, body: { error: "subscription_inactive" } }; assert.equal(await f.client.xResearchAccess(), null);
  f.x = { status: 404, body: { error: "unsupported" } }; assert.equal(await f.client.xResearchAccess(), null);
  f.x = { status: 200, body: { cloudContractVersion: 1, url: "https://elsewhere.example.test/api/cloud/services/x", token } }; await assert.rejects(f.client.xResearchAccess(), /Invalid/);
  f.x = { status: 200, body: { cloudContractVersion: 1, url, token: "short" } }; await assert.rejects(f.client.xResearchAccess(), /Invalid/);
  f.x = { status: 500, body: { error: "down" } }; await assert.rejects(f.client.xResearchAccess());
});

test("pages access: this sign-in's own pages token on any plan, null without the service, never a URL off the Cloud's origin", async t => {
  const f = await fixture(t);
  const before = f.requests.length;
  assert.equal(await f.client.pagesAccess(), null);
  assert.equal(f.requests.length, before);
  await f.connect();
  const token = `omb_pd_${"a".repeat(43)}`, url = `${f.origin}/api/cloud/pages/token`;
  f.pages = { status: 200, body: { cloudContractVersion: 1, url, token } };
  assert.deepEqual(await f.client.pagesAccess(), { url, token });
  assert.ok(f.requests.some(r => r.route === "/api/cloud/desktop/services/pages" && r.method === "POST" && r.token === `Bearer ${accessToken}`));
  f.pages = { status: 404, body: { error: "unsupported" } }; assert.equal(await f.client.pagesAccess(), null);
  f.pages = { status: 200, body: { cloudContractVersion: 1, url: "https://elsewhere.example.test/api/cloud/pages/token", token } }; await assert.rejects(f.client.pagesAccess(), /Invalid/);
  f.pages = { status: 200, body: { cloudContractVersion: 1, url, token: `omb_xd_${"a".repeat(43)}` } }; await assert.rejects(f.client.pagesAccess(), /Invalid/);
  f.pages = { status: 500, body: { error: "down" } }; await assert.rejects(f.client.pagesAccess());
});

test("My Cloud's line in the server menus says what is true now: the trial's end while it is ahead, always on while paid for, stopped when not, nothing when unknown", () => {
  const date = value => new Date(value).toISOString().slice(0, 10);
  const connected = (extra = {}) => ({ status: "connected", account: { id: "a", email: "a@example.test" }, entitlement: { plan: "pro", tier: "pro", status: "active", expiresAt: 2e12, version: 1 }, ...extra });
  const ends = Date.UTC(2026, 9, 15);
  assert.equal(cloudMenuSublabel(connected({ trial: { state: "active", endsAt: ends } }), date), "Free trial until 2026-10-15");
  assert.equal(cloudMenuSublabel(connected({ trial: { state: "ending", endsAt: ends } }), date), "Free trial until 2026-10-15");
  assert.equal(cloudMenuSublabel(connected({ trial: { state: "processing", endsAt: ends } }), date), "Always on");
  assert.equal(cloudMenuSublabel(connected(), date), "Always on");
  const inactive = { plan: "pro", tier: "pro", status: "inactive", expiresAt: null, version: 2 };
  for (const state of [connected({ entitlement: inactive, trial: { state: "ended", endsAt: ends }, machine: { status: "stopped" } }),
    connected({ entitlement: inactive, trial: { state: "late", endsAt: ends } }), connected({ entitlement: inactive, machine: { status: "payment-problem" } }),
    connected({ entitlement: { plan: "free", status: "inactive", expiresAt: null, version: 3 }, machine: { status: "stopped" } })]) assert.equal(cloudMenuSublabel(state, date), "Stopped");
  for (const state of [null, { status: "signed-out" }, { status: "reauth-required", message: "expired", lastPlan: { tier: "pro", active: true } }, { status: "unavailable" },
    connected({ entitlement: { plan: "free", status: "inactive", expiresAt: null, version: 1 } })]) assert.equal(cloudMenuSublabel(state, date), null);
});

test("the session's teams come with a verified session, each with its Cloud; a team pairing is asked of the Admin's team route for the team's own address, and 404 means the person is no longer in it", async t => {
  const f = await fixture(t); await f.connect();
  const origin = "https://omb-u-acme.fly.dev", code = "AAAA-BBBB-CCCC";
  assert.equal(f.client.state().teams, undefined, "in no team: nothing added");
  f.teams = [{ id: "team-acme", name: "Acme", role: "member", machine: { state: "ready", origin, pairingAvailable: true, status: "ready" } }, { id: "team-x", name: "Later", role: "admin", machine: null }];
  await f.client.refresh();
  assert.deepEqual(f.client.state().teams, [{ id: "team-acme", name: "Acme", role: "member", machine: { status: "ready", origin } }, { id: "team-x", name: "Later", role: "admin", machine: null }]);
  assert.equal(f.client.homeTarget(), null, "a team's Cloud is never My Cloud");
  await assert.rejects(f.client.pairTeam("team-x"), { message: "Later isn't ready to open yet." });
  await assert.rejects(f.client.pairTeam("team-nope"), { gone: true });
  f.teamPairing = { status: 200, body: { cloudContractVersion: 1, origin, code, pairingUrl: `${origin}/pair#code=${code}`, expiresAt: f.now + 300_000, credential: "omb_pair_x" } };
  assert.deepEqual(await f.client.pairTeam("team-acme"), { origin, code, expiresAt: f.now + 300_000 });
  const asked = f.requests.filter(request => request.route.includes("/teams/"));
  assert.deepEqual(asked.map(request => [request.route, request.method, request.token]), [["/api/cloud/desktop/teams/team-acme/pairing", "POST", `Bearer ${accessToken}`]]);
  f.teamPairing = { status: 200, body: { cloudContractVersion: 1, origin: "https://other.fly.dev", code, expiresAt: f.now + 300_000 } };
  await assert.rejects(f.client.pairTeam("team-acme"), { message: "Invalid Cloud pairing response." }, "a code for another address never connects");
  f.teamPairing = { status: 409, body: { error: "cloud_unavailable" } };
  await assert.rejects(f.client.pairTeam("team-acme"), { message: "Acme isn't running right now." });
  f.teamPairing = { status: 404, body: { error: "not_found" } };
  f.teams = [];
  await assert.rejects(f.client.pairTeam("team-acme"), { gone: true, message: "You're no longer in Acme." });
  await until(() => f.client.state().teams === undefined);
  f.teams = undefined; await f.client.refresh();
  assert.equal(f.client.state().teams, undefined, "an older Admin: no teams");
});

test("this computer tells the Admin where its move stands with its own sign-in; nothing without one, and nothing more from an Admin that can't take it", async t => {
  const f = await fixture(t), report = { v: 1, appVersion: "0.1.129", phase: "none", reason: "moves_off", keepHere: false, since: null, startedAt: null, passes: null, retryAt: null, busy: null, cloudState: "ready", failure: null };
  assert.equal(await f.client.reportMoveStatus(report), false, "nobody signed in");
  assert.equal(f.requests.some(r => r.route === "/api/cloud/desktop/move-status"), false);
  await f.connect();
  assert.equal(await f.client.reportMoveStatus(report), false, "an Admin that can't take it yet");
  f.moveStatus = { status: 200, body: { cloudContractVersion: 1, recorded: true } };
  assert.equal(await f.client.reportMoveStatus(report), true);
  const said = f.requests.findLast(r => r.route === "/api/cloud/desktop/move-status");
  assert.deepEqual([said.method, said.token, said.version, JSON.parse(said.body)], ["POST", `Bearer ${accessToken}`, "0.1.fixture", report]);
  f.moveStatus = { status: 429, body: { error: "rate_limited" } };
  await assert.rejects(f.client.reportMoveStatus(report), { status: 429 });
});

test("this computer tells the Admin its move is done, and asks for an ended Cloud's export, as itself; as before when it can't say", async t => {
  const f = await fixture(t), computer = "C".repeat(43);
  assert.equal(await f.client.reportMove({ installation: computer }), false, "nobody signed in");
  await f.connect();
  assert.equal(await f.client.reportMove({ installation: computer }), false, "an Admin that can't take it yet");
  f.moved = { status: 200, body: { cloudContractVersion: 1, recorded: true } };
  assert.equal(await f.client.reportMove({ installation: computer }), true);
  const said = f.requests.findLast(r => r.route === "/api/cloud/desktop/moved");
  assert.deepEqual([said.method, said.token, JSON.parse(said.body)], ["POST", `Bearer ${accessToken}`, { installation: computer }]);
  f.moved = { status: 409, body: { error: "not_moved" } };
  await assert.rejects(f.client.reportMove({ installation: computer }));
  await assert.rejects(f.client.exportHome({ installation: computer }));
  assert.deepEqual(JSON.parse(f.requests.findLast(r => r.route === "/api/cloud/desktop/export").body), { installation: computer });
  await assert.rejects(f.client.exportHome());
  assert.deepEqual(JSON.parse(f.requests.findLast(r => r.route === "/api/cloud/desktop/export").body), {});
});

test("connecting before My Cloud is ready is refused in the app's language", async t => {
  const english = await fixture(t);
  await assert.rejects(english.client.pairHome(), { message: "My Cloud is not ready to connect yet." });
  const { t: words } = nativeText.createNativeText({ saved: "pt-br" });
  const translated = await fixture(t, { t: words });
  await assert.rejects(translated.client.pairHome(), { message: "Ainda não é possível se conectar ao Cloud." });
});

test("usage meter: the session's usage reaches the state and the Cloud page's snapshot, checked", async t => {
  const f = await fixture(t);
  f.entitlement = { plan: "pro", tier: "pro", status: "active", expiresAt: f.now + 30 * 86400_000, version: 1 };
  const resetsAt = f.now + 7 * 86400_000;
  f.cloud = { state: "ready", origin: "https://cloud-home.example.test", pairingAvailable: true, usage: { tier: "pro", resetsAt,
    meters: [{ kind: "computerHours", used: 250, max: 300 }, { kind: "tokens", used: 1, max: 2 }, { kind: "voice", used: 5, max: 0 }, { kind: "x", used: 5_000, max: 5_000, usedUp: true }],
    upgrades: [{ tier: "max", amount: 9900 }, { tier: "gold", amount: 1 }, { tier: "pro", amount: 4900 }] } };
  await f.connect();
  const usage = { tier: "pro", resetsAt, meters: [{ kind: "computerHours", used: 250, max: 300 }, { kind: "x", used: 5_000, max: 5_000, usedUp: true }] };
  assert.deepEqual(f.client.state().usage, usage);
  assert.deepEqual(cloudPlanSnapshot(f.client.state()).usage, usage);

});

test("usage meter: no usage without an active plan, and none from a malformed answer", async t => {
  const f = await fixture(t);
  f.cloud = { state: "ready", origin: "https://cloud-home.example.test", pairingAvailable: true, usage: { tier: "pro", resetsAt: f.now, meters: [], upgrades: [] } };
  await f.connect();
  assert.equal(f.client.state().usage, undefined);
  assert.equal(cloudPlanSnapshot(f.client.state()).usage, undefined);
  f.entitlement = { plan: "pro", tier: "pro", status: "active", expiresAt: f.now + 30 * 86400_000, version: 1 };
  f.cloud = { ...f.cloud, usage: { tier: "pro", meters: "lots" } };
  await f.client.refresh();
  assert.equal(f.client.state().status, "connected");
  assert.equal(f.client.state().usage, undefined);
});

const MY_CLOUD = "3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b", TEAM_CLOUD = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d", DAY = 86_400_000;
/** The session's `clouds` as the Admin lists them: a team Cloud this person is only in, and their own primary Cloud on a trial. */
function renewingClouds(f, renewal = { trial: true, endsAt: null, keptDays: 3 }) {
  return [{ id: TEAM_CLOUD, name: "Acme", role: "member", teamId: "team-acme", primary: false, renewsAt: null, cancelAtPeriodEnd: false },
    { id: MY_CLOUD, name: "My Cloud", role: "owner", teamId: null, primary: true, renewsAt: renewal.endsAt === null ? f.now + 5 * DAY : null, cancelAtPeriodEnd: renewal.endsAt !== null, renewal }];
}
/** An Admin with the app's Cancel and Keep: each turns the Cloud's renewal off or on, and the next session says so. */
function renewalAdmin(f) {
  f.feedback = { status: 201, body: { cloudContractVersion: 1, id: "answer-1" } };
  f.renewal = (action, cloudId) => {
    if (cloudId !== MY_CLOUD) return { status: 404, body: { error: "not_found", errorDescription: "There is no such Cloud on your account." } };
    f.clouds = renewingClouds(f, { trial: true, endsAt: action === "cancel" ? f.now + 5 * DAY : null, keptDays: 3 });
    return { status: 200, body: { cloudContractVersion: 1, cloud: f.clouds[1] } };
  };
}
const posts = f => f.requests.filter(request => request.method === "POST" && /\/(?:feedback|cancel|keep)$/.test(request.route))
  .map(request => [request.route.replace("/api/cloud/desktop/", ""), JSON.parse(request.body || "null"), request.token === `Bearer ${accessToken}`]);

test("the plan's renewal comes from the session's own primary Cloud, for display only; the Cloud's id stays in main", async t => {
  const f = await fixture(t);
  f.entitlement = { plan: "pro", tier: "pro", status: "active", expiresAt: f.now + 30 * DAY, version: 2 };
  f.clouds = renewingClouds(f);
  await f.connect();
  assert.deepEqual(f.client.state().renewal, { trial: true, cancelled: false, renewsAt: f.now + 5 * DAY, endsAt: null, keptDays: 3 });
  assert.equal(JSON.stringify(f.client.state()).includes(MY_CLOUD), false);
  assert.deepEqual(cloudPlanSnapshot(f.client.state()).renewal, f.client.state().renewal);
  // Someone in a team Cloud they don't pay for, and an Admin that doesn't say: no renewal, so nothing to cancel.
  f.clouds = [renewingClouds(f)[0], { ...renewingClouds(f)[1], primary: false }];
  await f.client.refresh();
  assert.equal(f.client.state().renewal, undefined);
  f.clouds = undefined;
  await f.client.refresh();
  assert.equal(f.client.state().renewal, undefined);
  assert.deepEqual(await f.client.cancelPlan({ answer: "price" }), { outcome: "failed", state: f.client.state() });
  assert.deepEqual(posts(f), [], "nothing is asked without a Cloud the session names");
});

test("Cancel plan sends the survey first, then the session's own Cloud's cancel; the survey never blocks it, and Keep turns renewal back on", async t => {
  const f = await fixture(t);
  f.entitlement = { plan: "pro", tier: "pro", status: "active", expiresAt: f.now + 30 * DAY, version: 2 };
  f.clouds = renewingClouds(f);
  renewalAdmin(f);
  await f.connect();
  // The page names no Cloud: a cloudId it sends is never used, and each box is trimmed.
  const cancelled = await f.client.cancelPlan({ answer: "price", expected: "  To sort my inbox.  ", improve: "", cloudId: TEAM_CLOUD });
  assert.deepEqual(posts(f), [["feedback", { cloudId: MY_CLOUD, answer: "price", expected: "To sort my inbox." }, true], [`clouds/${MY_CLOUD}/cancel`, {}, true]]);
  assert.equal(cancelled.outcome, "cancelled");
  assert.deepEqual(cancelled.renewal, { trial: true, cancelled: true, renewsAt: null, endsAt: f.now + 5 * DAY, keptDays: 3 });
  assert.equal(cancelled.surveyed, true);
  assert.deepEqual(f.client.state().renewal, cancelled.renewal, "the session is read again");
  // Keep my plan: the same Cloud, nothing else sent.
  f.requests.length = 0;
  const kept = await f.client.keepPlan();
  assert.equal(kept.outcome, "kept");
  assert.deepEqual(posts(f), [[`clouds/${MY_CLOUD}/keep`, {}, true]]);
  assert.equal(f.client.state().renewal.cancelled, false);
  // Nothing said: only the cancel. Words without a reason: kept as "other". A refused or failed survey: the cancel goes ahead.
  for (const [survey, sent] of [[null, null], [{}, null], [{ answer: "keep" }, null], ["price", null], [{ improve: "Tell me sooner." }, { answer: "other", improve: "Tell me sooner." }]]) {
    f.requests.length = 0;
    assert.equal((await f.client.cancelPlan(survey)).outcome, "cancelled");
    assert.deepEqual(posts(f), [...sent ? [["feedback", { cloudId: MY_CLOUD, ...sent }, true]] : [], [`clouds/${MY_CLOUD}/cancel`, {}, true]]);
    await f.client.keepPlan();
  }
  for (const refusal of [{ status: 429, body: { error: "rate_limited", interval: 600 } }, { status: 500, body: { error: "unexpected" } }]) {
    f.feedback = refusal; f.requests.length = 0;
    const result = await f.client.cancelPlan({ answer: "setup" });
    assert.deepEqual([result.outcome, result.surveyed], ["cancelled", false]);
    assert.deepEqual(posts(f).map(([route]) => route), ["feedback", `clouds/${MY_CLOUD}/cancel`]);
    await f.client.keepPlan();
  }
});

test("an Admin without the app's Cancel and Keep opens the Cloud page's billing; a refusal changes nothing and reads the session again", async t => {
  const f = await fixture(t);
  f.entitlement = { plan: "pro", tier: "pro", status: "active", expiresAt: f.now + 30 * DAY, version: 2 };
  f.clouds = renewingClouds(f);
  await f.connect();
  f.browsers.length = 0;
  for (const status of [404, 405, 501]) {
    f.renewal = () => ({ status, body: { error: status === 404 ? "Not found." : "unsupported" } });
    assert.deepEqual(await f.client.cancelPlan({ answer: "later" }), { outcome: "browser" });
    assert.deepEqual(await f.client.keepPlan(), { outcome: "browser" });
  }
  assert.deepEqual(f.browsers, Array(6).fill(`${f.origin}/cloud/personal/billing`));
  // The route is there, but refuses: the Cloud isn't this account's (anymore), or there's no plan to change, or Dodo can't be reached.
  for (const [status, error] of [[404, "not_found"], [403, "forbidden"], [409, "not_renewable"], [502, "provider_error"], [429, "rate_limited"]]) {
    f.renewal = () => ({ status, body: { error, errorDescription: "Refused." } });
    const reads = f.requests.filter(request => request.route === "/api/cloud/desktop/session").length;
    const result = await f.client.cancelPlan(null);
    assert.equal(result.outcome, "failed", `${status} ${error}`);
    assert.equal(f.requests.filter(request => request.route === "/api/cloud/desktop/session").length, reads + ([404, 409].includes(status) ? 1 : 0));
  }
  assert.equal(f.browsers.length, 6, "only an Admin without the routes opens the browser");
});

test("the cancel survey as main sends it: one of the reasons, words trimmed and at most 2,000 characters each, never anything else", () => {
  assert.deepEqual(cancelSurvey({ answer: "broken", expected: " a ", improve: " b " }), { answer: "broken", expected: "a", improve: "b" });
  assert.deepEqual(cancelSurvey({ answer: null, expected: "only words" }), { answer: "other", expected: "only words" });
  assert.deepEqual(cancelSurvey({ answer: "later", expected: 7, improve: ["no"] }), { answer: "later" });
  for (const nothing of [null, undefined, "price", ["price"], {}, { answer: null, expected: "   " }, { answer: "keep" }, { answer: "price", expected: "x".repeat(2_001) },
    { answer: "price", improve: "y".repeat(2_001) }]) assert.equal(cancelSurvey(nothing), null, JSON.stringify(nothing)?.slice(0, 60));
  assert.equal(cancelSurvey({ answer: "price", expected: "z".repeat(2_000) }).expected.length, 2_000);
});
