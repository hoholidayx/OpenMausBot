import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import { cloudPageSenderAllowed } from "./cloud-home.mjs";
import environments from "./environments.cjs";
import { HOME_SCREEN_PATH, homeOf, installHomeWindowIpc, LOOK_MS, OPEN_MS, placeOf, QUIET_MS, SPLASH_TEXT, splashText, UPDATING_MS } from "./home-window.mjs";
import { ACCOUNT, ACME, CLIENT, CLIENT_A, CLOUD, connected, done, LOCAL, TEAM, world } from "./fixtures/home-window-world.mjs";

/** Everything already queued runs before this comes back: what the fake clock's callbacks left to flush. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("home is My Cloud only once the move switched and the same account is signed in; anything else is this computer or the sign-in screen", () => {
  assert.deepEqual(homeOf({}), { kind: "computer" }, "no Cloud: nothing changes");
  assert.deepEqual(homeOf({ state: connected() }), { kind: "computer" }, "a Cloud the move hasn't reached is still not home");
  for (const phase of ["copy", "wait", "freeze", "final", "check", "home-again", "back"]) {
    assert.deepEqual(homeOf({ journal: { ...done(), phase }, state: connected() }), { kind: "computer" }, phase);
  }
  for (const phase of ["switch", "done"]) assert.deepEqual(homeOf({ journal: { ...done(), phase }, state: connected() }), { kind: "cloud", origin: CLOUD }, phase);
  assert.deepEqual(homeOf({ journal: done(), state: { ...connected(), account: { id: "acct-2" } } }), { kind: "signin", other: true }, "another account never sees this computer's copy");
  for (const state of [null, { status: "signed-out" }, { status: "connecting" }, { status: "signed-out", account: ACCOUNT }]) {
    assert.deepEqual(homeOf({ journal: done(), state }), { kind: "signin" }, JSON.stringify(state));
  }
  assert.deepEqual(homeOf({ journal: done(), state: { status: "reauth-required", account: ACCOUNT } }), { kind: "cloud", origin: CLOUD }, "an ended grant still opens My Cloud on the window's own session");
  assert.deepEqual(homeOf({ journal: done(), state: { status: "unavailable", account: ACCOUNT } }), { kind: "cloud", origin: CLOUD }, "the Admin not answering is not a sign-out");
  assert.deepEqual(homeOf({ journal: done(), state: connected({ hold: { until: 9 } }) }), { kind: "computer" }, "My Cloud ended: everything comes home");
});

test("a frozen copy with its journal lost counts as moved, to the Cloud it names or the account's own", () => {
  assert.deepEqual(homeOf({ frozenCloud: CLOUD, state: connected() }), { kind: "cloud", origin: CLOUD });
  assert.deepEqual(homeOf({ frozenCloud: true, state: connected() }), { kind: "cloud", origin: CLOUD });
  assert.deepEqual(homeOf({ frozenCloud: "https://omb-t-2.fly.dev", state: connected() }), { kind: "signin", other: true });
  assert.deepEqual(homeOf({ frozenCloud: true, state: { status: "unavailable", account: ACCOUNT } }), { kind: "signin" }, "no Cloud to name: the sign-in screen, never the frozen copy");
  assert.deepEqual(homeOf({ frozenCloud: CLOUD, state: null }), { kind: "signin" });
  assert.deepEqual(homeOf({ journal: { ...done(), phase: "freeze" }, frozenCloud: CLOUD, state: connected() }), { kind: "computer" }, "a move under way is not a move done");
});

test("a server of the person's own their bots moved to is no Cloud: no sign-in, the window shows it as any saved server, and the frozen screen names it", async () => {
  const garage = "https://garage.example.test";
  const w = world({ journal: null, marker: { frozen: true, cloud: garage, place: "Garage server" }, state: { status: "signed-out" }, url: `${garage}/` });
  await w.home.show();
  assert.deepEqual([w.local, w.went, w.fetched, w.pairs], [[false], [], [], 0], "never the sign-in screen, nor any Cloud or the Admin asked");
  assert.equal(w.home.cloudOrigin(), null);
  const moving = world({ journal: null, marker: { frozen: true, cloud: garage, place: "Garage server" }, state: { status: "signed-out" }, ownMove: { phase: "final", name: "Garage server" } });
  assert.deepEqual(moving.home.view(), { screen: "moving", name: "Garage server" });
  moving.ownMove = { phase: "copy", name: "Garage server" };
  assert.deepEqual(moving.home.view(), { screen: "opening" }, "still home here: nothing is stopped yet");
});

test("a frozen copy left on this computer's own page goes back to the server it names, or says where the bots are", async () => {
  const garage = "https://garage.example.test";
  const marker = { frozen: true, cloud: garage, place: "Garage server" };
  // This computer's page has nothing to show for a frozen copy: the window goes back to the server, as any saved server does.
  const parked = world({ journal: null, marker, state: { status: "signed-out" }, url: `${LOCAL}${HOME_SCREEN_PATH}` });
  await parked.home.show();
  assert.deepEqual(parked.reopened, [{ origin: garage, place: "Garage server" }], "the server is asked for again, never the frozen page");
  assert.equal(parked.url, `${garage}/`, "the window is on the server");
  assert.deepEqual(parked.local, [], "this computer's frozen page is never shown");
  assert.deepEqual(parked.calls, ["ensure"], "a window is there to open it in");
  assert.deepEqual(parked.home.view(), { screen: "opening" }, "no screen of its own while the server opens");
  // A server forgotten here, or one that doesn't answer: the screen says where the bots are, and looks again by itself.
  const forgotten = world({ journal: null, marker, state: { status: "signed-out" }, url: `${LOCAL}${HOME_SCREEN_PATH}` });
  forgotten.reopenAnswer = false;
  await forgotten.home.show();
  assert.deepEqual(forgotten.home.view(), { screen: "offline", reason: "Your bots are on Garage server." });
  assert.equal(forgotten.timers.length, 1, "it looks again by itself");
  // The second try lands on the server, and the next show() leaves the window there, never back on the frozen page.
  forgotten.reopenAnswer = true;
  await forgotten.home.show();
  assert.equal(forgotten.url, `${garage}/`, "the retry opened the server");
  await forgotten.home.show();
  assert.deepEqual(forgotten.local, [false], "already on the server: nothing moves the window back");
  // A show() that overlaps the recovery, while its page is still loading, leaves the window where it is going.
  const racing = world({ journal: null, marker, state: { status: "signed-out" }, url: `${LOCAL}${HOME_SCREEN_PATH}` });
  racing.reopenAnswer = false;
  await racing.home.show();
  const before = racing.reopened.length;
  racing.reopenAnswer = true;
  let release = () => {};
  racing.reopenGate = new Promise((done) => { release = done; });
  const recovering = racing.home.show();
  for (let i = 0; i < 200 && racing.reopened.length === before; i++) await tick();
  racing.url = `${garage}/`;
  await racing.home.show();
  release();
  await recovering;
  assert.equal(racing.url, `${garage}/`, "an overlapping show() never pulls the window back to the frozen page");
  assert.deepEqual(racing.local, [], "it leaves the window, and the deadline, to the recovery");
  // The recovery's own page failing to load is this app's to answer, not main's generic "not reachable" dialog.
  const loading = world({ journal: null, marker, state: { status: "signed-out" }, url: `${LOCAL}${HOME_SCREEN_PATH}` });
  await loading.home.show();
  assert.equal(loading.home.failed(`${garage}/chats`, -105), true, "the way back's load failure is answered here");
  assert.deepEqual(loading.home.view(), { screen: "offline", reason: "Your bots are on Garage server." });
  // A recovery whose page never commits is bounded: the screen says where the bots are, with a retry, within OPEN_MS.
  const stuck = world({ journal: null, marker, state: { status: "signed-out" }, url: `${LOCAL}${HOME_SCREEN_PATH}` });
  stuck.reopenGate = new Promise(() => {});
  let back = false;
  const waiting = stuck.home.show().then(() => { back = true; });
  for (let i = 0; i < 200 && stuck.timers.length === 0; i++) await tick();
  await stuck.later(OPEN_MS);
  await tick();
  assert.equal(back, true, "the deadline hands show() back");
  await waiting;
  assert.deepEqual(stuck.home.view(), { screen: "offline", reason: "Your bots are on Garage server." }, "the screen says where they are");
  assert.equal(stuck.timers.length, 1, "and looks again by itself");
  // A move still under way is that screen's to say, not this one's.
  const moving = world({ journal: null, marker, state: { status: "signed-out" }, ownMove: { phase: "final", name: "Garage server" }, url: `${LOCAL}${HOME_SCREEN_PATH}` });
  await moving.home.show();
  assert.deepEqual(moving.reopened, [], "an unfinished move is not opened");
  assert.deepEqual(moving.home.view(), { screen: "moving", name: "Garage server" });
  assert.equal(moving.home.failed(`${garage}/chats`, -105), true, "the move's own load failure is answered here too");
  assert.deepEqual(moving.home.view(), { screen: "moving", name: "Garage server" }, "never the offline screen in the middle of a move");
  assert.equal(moving.timers.length, 1, "and it looks again by itself");
  const keptBack = world({ journal: { ...done(), phase: "back" }, marker, state: { status: "signed-out" }, url: `${LOCAL}${HOME_SCREEN_PATH}` });
  await keptBack.home.show();
  assert.deepEqual(keptBack.reopened, [{ origin: garage, place: "Garage server" }], "a journal that keeps this computer does not hide the marker");
  const elsewhere = world({ journal: null, marker, state: { status: "signed-out" }, url: "https://studio.example.test/" });
  await elsewhere.home.show();
  assert.deepEqual(elsewhere.reopened, [], "a server already open is not left for the frozen one");
  assert.equal(elsewhere.url, "https://studio.example.test/", "the window stays where it is");
});


test("no Cloud: the window is this computer's as before, and nothing asks any Cloud or the Admin", async () => {
  const w = world({ journal: null, state: { status: "signed-out" }, url: `${LOCAL}/` });
  await w.home.show();
  assert.deepEqual(w.local, [false]);
  assert.deepEqual([w.went, w.fetched, w.pairs, w.wakes, w.splash], [[], [], 0, 0, []]);
  assert.equal(w.home.cloudOrigin(), null);
  const paid = world({ journal: null, state: connected(), url: "https://bots.example.test/" });
  await paid.home.show();
  assert.deepEqual([paid.local, paid.went, paid.fetched], [[false], [], []], "a Cloud the move hasn't reached changes nothing either, nor the saved server the window shows");
});

test("launching with My Cloud awake: a quick look, then My Cloud's page on the window's own session", async () => {
  const w = world();
  await w.home.show();
  assert.deepEqual(w.fetched, [["/api/health", "1"], ["/api/auth/session", null]], "the look never counts as someone using My Cloud");
  assert.deepEqual(w.went, [[CLOUD, CLOUD]]);
  assert.equal(w.pairs, 0);
  assert.deepEqual(w.splash, [SPLASH_TEXT.opening]);
  assert.equal(w.home.cloudOrigin(), CLOUD);
  w.fetched.length = 0;
  await w.home.show();
  assert.deepEqual([w.went.length, w.fetched], [1, []], "a window already on My Cloud is only brought forward");
});

test("a window that showed My Cloud as a saved server before the move is opened again as home, and goes home when My Cloud ends", async () => {
  // Seen in the real app on Oct 22: with moves off, the person opened My Cloud from the switcher; after the move the
  // window kept "Hosted: My Cloud", the switcher and "This computer", and when My Cloud ended it stayed on the ended Cloud.
  const w = world({ url: `${CLOUD}/` });
  await w.home.show({ place: "cloud" });
  assert.equal(w.went.length, 1, `opened as home, not left as the saved server it was: ${JSON.stringify(w.went)}`);
  w.state = connected({ hold: { until: 9 } });
  w.journal = { ...done(), phase: "home-again" };
  await w.home.show();
  assert.equal(w.local.at(-1), true, "My Cloud ended: the window leaves it for this computer");
});

test("launching with My Cloud asleep says Waking My Cloud… and wakes it through the Admin, never by a look, then shows the page", async () => {
  const w = world({ power: { state: "asleep", since: 1, sleeps: true } });
  await w.home.show();
  assert.deepEqual(w.splash, [SPLASH_TEXT.waking]);
  assert.equal(w.wakes, 1);
  assert.equal(w.fetched.some(([route]) => route === "/api/health"), false, "a sleeping Cloud is never looked at");
  assert.deepEqual(w.went, [[CLOUD, CLOUD]]);
  assert.ok(w.calls.includes("woke"));
});

test("another account: the sign-in screen says so, and My Cloud is never opened for it", async () => {
  const w = world({ state: { ...connected(), account: { id: "acct-2", email: "else@example.test" } } });
  await w.home.show();
  assert.deepEqual(w.home.view(), { screen: "signin", other: true });
  assert.deepEqual([w.fetched, w.pairs], [[], 0]);
});

test("with the network down the offline screen shows at once, with the Admin's reason, and goes away by itself", async () => {
  const w = world({ state: connected({ unreachable: { cause: "host", since: 1 } }), cloud: { down: true } });
  const started = Date.now();
  await w.home.show();
  assert.ok(Date.now() - started < LOOK_MS);
  assert.deepEqual(w.went, [[`${LOCAL}${HOME_SCREEN_PATH}`, null]]);
  const view = w.home.view();
  assert.equal(view.screen, "offline");
  assert.match(view.reason, /being restarted by our hosting provider/);
  assert.deepEqual([w.fetched, w.pairs], [[["/api/health", "1"]], 0], "a My Cloud that fails the look is asked nothing else, and never paired");
  assert.deepEqual(w.published.at(-1), view, "the screen is told");
  w.url = `${LOCAL}${HOME_SCREEN_PATH}`;
  await w.later(2_000);
  assert.equal(w.went.length, 1, "still down: it stays, and looks again later");
  w.cloud.down = false;
  await w.later(4_000);
  assert.deepEqual(w.went.at(-1), [CLOUD, CLOUD], "back: My Cloud's page, with nothing pressed");
  assert.equal(w.home.view().screen, "opening");
  w.url = `${CLOUD}/`;
  const moves = w.went.length;
  w.home.failed("https://other.example.test/");
  assert.deepEqual([w.home.view().screen, w.went.length], ["opening", moves], "another server failing to load is not My Cloud failing");
  w.home.failed(`${CLOUD}/chats`);
  assert.equal(w.home.view().screen, "offline", "My Cloud's page failing to load is the same screen");
  assert.deepEqual(w.went.at(-1), [`${LOCAL}${HOME_SCREEN_PATH}`, null]);
});

test("a plan problem shows the Admin's state and never knocks on My Cloud", async () => {
  for (const status of ["stopped", "payment-problem", "failed"]) {
    const w = world({ state: connected({ status }) });
    await w.home.show();
    assert.deepEqual(w.home.view(), { screen: "plan", machine: status }, status);
    assert.deepEqual(w.fetched, [], status);
  }
});

test("while home is My Cloud the startup screen says Opening My Cloud…, whichever screen comes next; otherwise it keeps its own words", async () => {
  for (const [state, cloud] of [[connected({ status: "stopped" }), {}], [{ status: "signed-out" }, {}], [connected(), { down: true }], [connected(), {}]]) {
    const w = world({ state, cloud });
    await w.home.show();
    assert.deepEqual(w.splash, [SPLASH_TEXT.opening], `${JSON.stringify(state)} ${JSON.stringify(cloud)}`);
  }
  for (const w of [world({ journal: null }), world({ state: connected({ hold: { until: 9 } }) }), world({ journal: { ...done(), phase: "copy" } })]) {
    await w.home.show();
    assert.deepEqual(w.splash, [], "home is this computer");
  }
});

test("a slow wake never moves the window after a newer request; a long one hands the startup screen to this computer's", async () => {
  let woken;
  const w = world({ power: { state: "asleep", since: 1, sleeps: true }, cloud: { wakeGate: new Promise((resolve) => { woken = resolve; }) } });
  const waking = w.home.show();
  await w.later(0);
  assert.deepEqual(w.went, [], "the startup screen says it first");
  await w.later(6_000);
  assert.deepEqual(w.went, [[`${LOCAL}${HOME_SCREEN_PATH}`, null]], "the screen says Waking My Cloud… once the startup screen has been up long enough");
  assert.equal(w.home.view().screen, "waking");
  woken();
  await waking;
  assert.deepEqual(w.went.at(-1), [CLOUD, CLOUD], "then the page");
  let release;
  const settled = world({ power: { state: "asleep", since: 1, sleeps: true }, cloud: { wakeGate: new Promise((resolve) => { release = resolve; }) } });
  const first = settled.home.show();
  await new Promise((resolve) => setImmediate(resolve));
  settled.journal = { ...done(), phase: "home-again" };
  const second = settled.home.show();
  release();
  await Promise.all([first, second]);
  assert.deepEqual(settled.went.filter(([, origin]) => origin === CLOUD), [], "the newer request (this computer, home again) wins");
  assert.deepEqual(settled.local, [true]);
});

test("a newer My Cloud page reloads at a quiet moment; an asleep My Cloud is never asked", async () => {
  const w = world();
  await w.home.show();
  w.home.navigated(`${CLOUD}/`);
  await w.tick();
  w.cloud.version = "0.1.131";
  w.typed = w.clock;
  await w.tick();
  assert.equal(w.reloads, 0, "the person is typing");
  w.clock += QUIET_MS;
  await w.tick();
  assert.equal(w.reloads, 1);
  await w.tick();
  assert.equal(w.reloads, 1, "once");
  w.power = { state: "asleep", since: 2 };
  const asked = w.fetched.length;
  w.cloud.version = "0.1.132";
  w.clock += QUIET_MS;
  await w.tick();
  assert.deepEqual([w.fetched.length, w.reloads], [asked, 1]);
});

test("My Cloud's page that the window reloaded for its newer version learns it once, as it loads, to say Updating My Cloud…", async () => {
  const w = world();
  await w.home.show();
  const listeners = new Map();
  installHomeWindowIpc({ ipcMain: { handle() {}, on: (channel, listener) => listeners.set(channel, listener) }, homeWindow: w.home, cloudPage: () => null });
  const asks = (event = { sender: w.contents, senderFrame: w.contents.mainFrame }) => { listeners.get("home:updating")(event); return event.returnValue; };
  w.url = `${CLOUD}/`;
  w.home.navigated(w.url);
  await w.tick();
  assert.equal(asks(), false, "a page that loads for any other reason");
  w.cloud.version = "0.1.131";
  w.clock += QUIET_MS;
  await w.tick();
  assert.equal(w.reloads, 1);
  assert.equal(asks({ sender: {}, senderFrame: w.contents.mainFrame }), false, "another window is never told");
  assert.equal(asks(), true, "the reloaded page");
  assert.equal(asks(), false, "once");
  w.cloud.version = "0.1.132";
  w.clock += QUIET_MS;
  await w.tick();
  assert.equal(w.reloads, 2);
  w.clock += UPDATING_MS;
  assert.equal(asks(), false, "a page that loads long after is not that version");
});

test("My Cloud ending brings the window back to this computer's page", async () => {
  const w = world();
  await w.home.show();
  w.state = connected({ hold: { until: 9 } });
  await w.home.changed();
  assert.deepEqual(w.local, [true]);
  assert.equal(w.home.cloudOrigin(), null);
});

test("a change of home is told once as it happens: My Cloud after the move, this computer when My Cloud ends", async () => {
  const w = world();
  w.rehomeThrows = true;
  await w.home.show();
  await w.home.show();
  assert.deepEqual(w.rehomes, [{ kind: "cloud", origin: CLOUD }], "a listener that throws never stops the window");
  assert.equal(w.home.cloudOrigin(), CLOUD);
  w.state = connected({ hold: { until: 9 } });
  await w.home.changed();
  assert.deepEqual(w.rehomes, [{ kind: "cloud", origin: CLOUD }, { kind: "computer" }]);
  const never = world({ journal: null, state: { status: "signed-out" } });
  await never.home.show();
  await never.home.refresh();
  assert.deepEqual(never.rehomes, [], "no move: home stays this computer");
});

test("only the main window's main frame counts, at My Cloud's origin for its page and this computer's for the screen", async () => {
  const w = world();
  await w.home.show();
  const frame = w.contents.mainFrame;
  w.url = `${CLOUD}/`;
  assert.equal(w.home.homePage({ sender: w.contents, senderFrame: frame }), true);
  assert.equal(w.home.homePage({ sender: w.contents, senderFrame: { url: `${CLOUD}/` } }), false, "a subframe");
  assert.equal(w.home.homePage({ sender: {}, senderFrame: frame }), false, "another window");
  assert.equal(w.home.screenPage({ sender: w.contents, senderFrame: frame }), false);
  w.url = `${LOCAL}${HOME_SCREEN_PATH}`;
  assert.equal(w.home.homePage({ sender: w.contents, senderFrame: frame }), false);
  assert.equal(w.home.screenPage({ sender: w.contents, senderFrame: frame }), true);
  w.state = { status: "signed-out" };
  w.url = `${CLOUD}/`;
  await w.home.refresh();
  assert.equal(w.home.homePage({ sender: w.contents, senderFrame: frame }), false, "signed out, My Cloud's page is no longer this app's");
});

const PRELOAD = readFileSync(new URL("./preload.cjs", import.meta.url), "utf8");
function preload(origin, { home = false, activation = false, pairedElsewhere = false } = {}) {
  let bridge; const invoked = [], synced = [], listeners = new Map();
  vm.runInNewContext(PRELOAD, {
    process: { platform: "darwin", argv: [`--omb-local-origin=${LOCAL}`, ...(pairedElsewhere ? ["--openmausbot-remote-client"] : ["--omb-company-desktop=1"])] },
    location: { origin }, navigator: { userActivation: { isActive: activation } }, TextEncoder, localStorage: { getItem: () => null },
    queueMicrotask,
    require: () => ({ webUtils: {}, contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
      ipcRenderer: { on: (channel, listener) => listeners.set(channel, listener), removeListener() {}, send() {}, sendSync: (channel) => { synced.push(channel); return channel === "home:page" ? home : null; },
        invoke: (...args) => { invoked.push(args); return Promise.resolve(); } } }),
  });
  const tell = (channel, ...args) => listeners.get(channel)?.({}, ...args);
  return { bridge, invoked, synced, tell };
}

test("My Cloud's page in the app is the Cloud's own page, never a remote client: only a desktop paired to another computer is one", () => {
  assert.equal(preload(CLOUD, { home: true }).bridge.remoteClient, undefined, "a Cloud's own page isn't told it is remote at all");
  assert.equal(preload(LOCAL).bridge.remoteClient?.active, false);
  assert.equal(preload(LOCAL, { pairedElsewhere: true }).bridge.remoteClient?.active, true);
});

test("only the verified Cloud, open as this window's active server, counts as the Cloud page", () => {
  const frame = { url: `${CLOUD}/` }, contents = { mainFrame: frame };
  const context = { contents, homeOrigin: CLOUD, activeOrigin: CLOUD };
  assert.equal(cloudPageSenderAllowed({ sender: contents, senderFrame: frame }, context), true);
  assert.equal(cloudPageSenderAllowed({ sender: contents, senderFrame: { url: `${CLOUD}/` } }, context), false, "a subframe");
  assert.equal(cloudPageSenderAllowed({ sender: {}, senderFrame: frame }, context), false, "another window");
  assert.equal(cloudPageSenderAllowed({ sender: contents, senderFrame: frame }, { ...context, activeOrigin: "https://other.example.test" }), false);
  assert.equal(cloudPageSenderAllowed({ sender: contents, senderFrame: frame }, { ...context, homeOrigin: null }), false, "signed out of Cloud");
  const evil = { url: "https://evil.example.test/" }, evilContents = { mainFrame: evil };
  assert.equal(cloudPageSenderAllowed({ sender: evilContents, senderFrame: evil }, { contents: evilContents, homeOrigin: CLOUD, activeOrigin: CLOUD }), false);
});

const MAIN = readFileSync(new URL("./main.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("no page gets a control over lending this computer: not My Cloud's, another Cloud's or this computer's own, and main handles none", async () => {
  for (const origin of [CLOUD, "https://omb-c-a.fly.dev", LOCAL]) {
    const page = preload(origin, { activation: true });
    assert.equal(page.bridge.cloudLending, undefined, origin);
    assert.equal(page.bridge.cloudAccount?.lending, undefined, origin);
  }
  assert.deepEqual(MAIN.match(/ipcMain\.handle\("(?:cloud-)?lending:[^"]*"/g), null, "no lending channel at all");
});

test("main shows the switcher at home only with somewhere else to go: My Cloud alone has none", () => {
  const start = MAIN.indexOf("const homeAlone = "), end = MAIN.indexOf("\n", start);
  assert.ok(start > 0 && end > start);
  const cloud = { id: "c", kind: "remote", name: "My Cloud", origin: CLOUD }, office = { id: "o", kind: "remote", name: "Office", origin: "https://office.example.test" };
  const workspaces = [];
  const context = vm.createContext({ homeWindow: { cloudOrigin: () => CLOUD }, otherPlaces: environments.otherPlaces, environmentsState: { environments: [cloud], activeId: "c" },
    localProfiles: { places: () => workspaces } });
  vm.runInContext(`${MAIN.slice(start, end)}; this.homeAlone = homeAlone;`, context);
  assert.equal(context.homeAlone(), true, "My Cloud alone: no switcher");
  context.environmentsState = { environments: [cloud, office], activeId: "c" };
  assert.equal(context.homeAlone(), false, "a saved server besides: the switcher lists both");
  context.environmentsState = { environments: [cloud, { id: "l", kind: "local", name: "Lab", dataDir: "/lab" }], activeId: "c" };
  assert.equal(context.homeAlone(), true, "a named folder of this computer is not a place once home is My Cloud");
  workspaces.push({ id: "default" });
  assert.equal(context.homeAlone(), false, "a workspace of this computer's own is: the Server menu lists it, for when the rail is hidden");
  workspaces.length = 0;
  context.homeWindow = { cloudOrigin: () => null };
  assert.equal(context.homeAlone(), false, "no home: the switcher as before");
});

test("the place asked for: My Cloud unless a team is asked or remembered; a team is the session's, one the connected session no longer lists is gone, and one the Admin can't vouch for opens as saved", () => {
  const state = { ...connected(), teams: [ACME] };
  assert.deepEqual(placeOf({ state }), { kind: "cloud" });
  assert.deepEqual(placeOf({ ask: "cloud", remembered: { team: "team-acme" }, state }), { kind: "cloud" }, "asked for My Cloud: My Cloud");
  assert.deepEqual(placeOf({ ask: { team: "team-acme" }, state }), { kind: "team", id: "team-acme", name: "Acme", role: "member", origin: TEAM, machine: ACME.machine });
  assert.deepEqual(placeOf({ remembered: { team: "team-acme", name: "Old name", origin: "https://old.fly.dev" }, state }).origin, TEAM, "the session's address wins over the saved one");
  assert.deepEqual(placeOf({ ask: { team: "team-acme" }, state: { ...state, teams: [{ ...ACME, machine: null }] } }), { kind: "team", id: "team-acme", name: "Acme", role: "member", origin: null, machine: null });
  assert.deepEqual(placeOf({ remembered: { team: "team-acme", name: "Acme", origin: TEAM }, state: connected() }), { kind: "cloud", left: "Acme" }, "connected, not listed: gone, by name");
  assert.deepEqual(placeOf({ ask: { team: "team-acme", name: "Acme" }, state: connected() }), { kind: "cloud", left: "Acme" });
  assert.deepEqual(placeOf({ remembered: { team: "team-acme" }, state: connected() }), { kind: "cloud", left: null }, "gone, with no name to say");
  for (const state of [{ status: "unavailable", account: ACCOUNT }, { status: "reauth-required", account: ACCOUNT }, null]) {
    assert.deepEqual(placeOf({ remembered: { team: "team-acme", name: "Acme", origin: TEAM }, state }), { kind: "team", id: "team-acme", name: "Acme", role: null, origin: TEAM, machine: null }, JSON.stringify(state));
    assert.deepEqual(placeOf({ remembered: { team: "team-acme" }, state }), { kind: "cloud" }, "no saved address: My Cloud");
  }
  assert.equal(splashText("opening", "Acme"), "Opening Acme…");
  assert.equal(splashText("waking"), SPLASH_TEXT.waking);
});

test("launching opens the team remembered from last time; one the connected session no longer lists is gone: My Cloud, with its name said once", async () => {
  const w = world({ state: { ...connected(), teams: [ACME] }, remembered: { team: "team-acme", name: "Acme", origin: TEAM } });
  await w.home.show();
  assert.deepEqual(w.went, [[TEAM, TEAM, "team-acme"]], "the remembered team, on the window's own session");
  assert.deepEqual(w.left, []);
  // Removed from the team: the next sign-in check says so.
  w.state = connected();
  await w.home.changed();
  assert.deepEqual(w.went.at(-1), [CLOUD, CLOUD]);
  assert.deepEqual(w.left, ["Acme"]);
  assert.deepEqual(w.remembers.at(-1), null);
  assert.equal(w.home.placeOrigin(), CLOUD);
  assert.deepEqual(w.teamPairs, [], "a team gone is never paired");
});

test("a team's Cloud that can't be reached shows this computer's screen with the team's name and looks again by itself; My Cloud is untouched", async () => {
  const w = world({ state: { ...connected(), teams: [ACME] }, team: { down: true }, url: `${CLOUD}/` });
  await w.home.show({ place: { team: "team-acme" } });
  assert.deepEqual(w.went, [[`${LOCAL}${HOME_SCREEN_PATH}`, null]]);
  assert.deepEqual(w.home.view(), { screen: "offline", name: "Acme" }, "named, with no reason of My Cloud's");
  assert.equal(w.fetched.some(([route]) => !route.startsWith("team:")), false, "nothing asks My Cloud");
  w.team.down = false;
  await w.later(2_000);
  assert.deepEqual(w.went.at(-1), [TEAM, TEAM, "team-acme"], "back by itself");
  assert.deepEqual(w.home.view(), { screen: "opening", name: "Acme" });
  // The team's Cloud answering asleep is simply not reachable yet: no wake through the Admin.
  w.team.health = 503; w.url = `${LOCAL}/`;
  await w.home.show({ place: { team: "team-acme" } });
  assert.deepEqual(w.home.view(), { screen: "offline", name: "Acme" });
  assert.equal(w.wakes, 0);
});

test("going from a team to another server lets the team go: a later session check never pulls the window back", async () => {
  const w = world({ state: { ...connected(), teams: [ACME] } });
  await w.home.show({ place: { team: "team-acme" } });
  assert.equal(w.home.placeOrigin(), TEAM);
  // The Server menu moved the window to a saved server (main's switchEnvironment), not through the home window.
  w.remembered = null;
  w.url = "https://office.example.test/";
  w.home.navigated(w.url);
  assert.equal(w.home.shown(), null);
  assert.equal(w.home.placeOrigin(), CLOUD, "My Cloud is home again for the window's rules");
  const went = w.went.length;
  await w.home.changed();
  assert.equal(w.went.length, went, "the session check left the window where the person put it");
  // The team's own sign-in page or this computer's screen keep the team as the place.
  await w.home.show({ place: { team: "team-acme" } });
  w.home.navigated(`${LOCAL}${HOME_SCREEN_PATH}`);
  assert.equal(w.home.placeOrigin(), TEAM);
});

test("another Cloud of the person's own is the place asked for by its id, from the session's list; one it no longer lists is simply My Cloud again", () => {
  const state = { ...connected(), clouds: [{ ...CLIENT_A, id: "c-home", name: "My Cloud", origin: CLOUD, primary: true }, CLIENT_A] };
  assert.deepEqual(placeOf({ ask: { cloud: "c-a" }, state }), { kind: "own", id: "c-a", name: "Client A", role: "owner", origin: CLIENT, machine: { status: "ready", origin: CLIENT } });
  assert.deepEqual(placeOf({ remembered: { cloud: "c-a", name: "Client A", origin: CLIENT }, state }).kind, "own");
  assert.deepEqual(placeOf({ ask: { cloud: "c-home" }, state }), { kind: "cloud" }, "My Cloud is never another Cloud");
  assert.deepEqual(placeOf({ ask: { cloud: "c-a" }, state: connected() }), { kind: "cloud" }, "not listed (or an older Admin): My Cloud, nothing said");
  assert.deepEqual(placeOf({ remembered: { cloud: "c-a", name: "Client A", origin: CLIENT }, state: { status: "unavailable" } }),
    { kind: "own", id: "c-a", name: "Client A", role: null, origin: CLIENT, machine: null }, "while the Admin can't be asked, as it was saved");
  assert.deepEqual(placeOf({ ask: { cloud: "c-a" }, state: { ...state, clouds: [{ ...CLIENT_A, status: "setting_up", origin: null, setup: { step: "storage" } }] } }).machine,
    { status: "provisioning", setup: { step: "storage" } });
});

test("another Cloud of the person's own that the Admin says is asleep is never asked for its version; once the Admin says it is awake, it is", async () => {
  const w = world({ state: { ...connected(), clouds: [CLIENT_A] } });
  await w.home.show({ place: { cloud: "c-a" } });
  w.url = `${CLIENT}/`;
  w.home.navigated(w.url);
  await w.tick();
  const versions = () => w.fetched.filter(([route]) => route === "client:/.well-known/openmausbot/environment");
  const read = versions().length;
  assert.ok(read > 0, "the shown Cloud's version is read while it is awake");
  // The Clouds list says it sleeps (`power`, contract v1): any request reaching it would wake it.
  w.state = { ...w.state, clouds: [{ ...CLIENT_A, power: { state: "asleep", since: 5, sleeps: true } }] };
  await w.tick();
  await w.tick();
  assert.equal(versions().length, read, "a Cloud the Admin says is asleep is never asked");
  assert.deepEqual([w.home.asleepAt(CLIENT), w.home.asleepAt(CLOUD)], [true, false], "and the quiet updater asks the same: only that Cloud sleeps");
  w.state = { ...w.state, clouds: [{ ...CLIENT_A, power: { state: "awake", since: 6, sleeps: true } }] };
  await w.tick();
  assert.equal(versions().length, read + 1, "awake again, it is asked");
  assert.deepEqual(versions().at(-1), ["client:/.well-known/openmausbot/environment", "1"], "as a background read");
});

test("an account leaving: nothing under way for it goes on, and the next show takes the window off its place", async () => {
  const w = world({ journal: null, state: { status: "signed-out" }, url: `${CLOUD}/` });
  w.home.accountLeaving();
  assert.equal(w.home.shown(), null);
  await w.home.show();
  assert.deepEqual(w.local, [true], "the window showed that account's Cloud: this computer's page now");
  const here = world({ journal: null, state: { status: "signed-out" }, url: `${LOCAL}/` });
  here.home.accountLeaving();
  await here.home.show();
  assert.deepEqual(here.local, [false], "already on this computer's page: nothing moves");
});

const B_CLOUD = "https://omb-b.fly.dev";
const accountB = (machine) => ({ status: "connected", account: { id: "acct-2", email: "b@example.test" }, ...(machine ? { machine } : {}) });

test("moved to A's Cloud, B signed in with a Cloud of its own: B's Cloud opens, and A's frozen copy is never shown", () => {
  assert.deepEqual(homeOf({ journal: done(), state: accountB({ status: "ready", origin: B_CLOUD }) }), { kind: "cloud", origin: B_CLOUD, otherAccount: true });
  assert.deepEqual(homeOf({ journal: done(), state: accountB(null) }), { kind: "signin", other: true }, "B has no Cloud: the screen says where the bots are");
  assert.deepEqual(homeOf({ journal: done(), state: accountB({ status: "stopped", hold: { until: 9 } }) }), { kind: "signin", other: true }, "B's Cloud ended: never this computer's frozen copy");
  assert.deepEqual(homeOf({ journal: done(), state: { status: "unavailable", account: { id: "acct-2" } } }), { kind: "signin", other: true }, "before the Admin answers");
  assert.deepEqual(homeOf({ journal: done(), state: { status: "reauth-required", account: { id: "acct-2" } } }), { kind: "signin", other: true });
});
