import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import localOrigin from "./local-origin.cjs";
import environments from "./environments.cjs";

const origin = "http://127.0.0.1:48993", methods = ["state", "begin", "signInAgain", "reopen", "cancel", "refresh", "signOut", "openDashboard"];
const bridgeMethods = [...methods, "connectHome", "connectHomeForPhone"];
function preload({ enabled = true, remote = false } = {}) {
  let bridge; const invoked = [];
  vm.runInNewContext(readFileSync(new URL("./preload.cjs", import.meta.url), "utf8"), {
    process: { platform: "fixture", argv: [`--omb-local-origin=${origin}`, ...(enabled ? ["--omb-company-desktop=1"] : [])] },
    location: { origin: remote ? "https://remote.example.test" : origin }, TextEncoder, localStorage: { getItem: () => null },
    require: () => ({ webUtils: {}, contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
      ipcRenderer: { on() {}, removeListener() {}, send() {}, invoke: (...args) => { invoked.push(args); return Promise.resolve({ status: "signed-out" }); } } }),
  });
  return { bridge, invoked };
}
test("personal Cloud bridge is desktop-local, contains no capability access, and discards all renderer arguments", async () => {
  const f = preload();
  for (const method of bridgeMethods) await f.bridge.cloudAccount[method]({ origin: "https://evil.example.test", paid: true, accessToken: "forged", code: "ABCD-EFGH-JKLM" });
  assert.deepEqual(f.invoked, bridgeMethods.map(method => [`cloud-account:${method}`]));
  assert.equal(f.bridge.cloudAccount.connection, undefined);
  assert.equal(preload({ enabled: false }).bridge.cloudAccount, undefined);
  assert.equal(preload({ remote: true }).bridge.cloudAccount, undefined);
});
test("production personal Cloud IPC guards exact local main frame and forwards no arguments", async () => {
  const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8"), start = source.indexOf("const workspaceOnly ="), end = source.indexOf('ipcMain.handle("organization:settings-opened"', start);
  assert.ok(start >= 0 && end > start);
  const handlers = new Map(), calls = [], frame = { url: `${origin}/` }, contents = { mainFrame: frame };
  localOrigin.setLocalOrigin(origin);
  const context = vm.createContext({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    localOnly: localOrigin.localOnly, workspaceSenderAllowed: environments.workspaceSenderAllowed, mainWindow: { webContents: contents },
    rendererOrigin: () => origin, environmentsState: { environments: [], activeId: "local" },
    ensureCloudAccount: () => Object.fromEntries(methods.map(method => [method, (...args) => { calls.push([method, ...args]); return { status: "signed-out" }; }])),
    connectCloudHome: (...args) => { calls.push(["connectHome", ...args]); return { status: "connected" }; },
    accounts: { signOutActive: (...args) => { calls.push(["signOut", ...args]); return { status: "signed-out" }; } },
  });
  vm.runInContext(source.slice(start, end), context);
  for (const method of bridgeMethods) {
    const handle = handlers.get(`cloud-account:${method}`);
    await handle({ sender: contents, senderFrame: frame }, { paid: true });
    for (const sender of [{ sender: contents, senderFrame: { url: `${origin}/subframe` } }, { sender: {}, senderFrame: frame },
      { sender: contents, senderFrame: { url: "https://remote.example.test" } }, { sender: contents }]) assert.throws(() => handle(sender), /only available/);
  }
  assert.deepEqual(calls, bridgeMethods.map(method => method === "connectHomeForPhone" ? ["connectHome", "phone"] : [method]));
});
test("a team's Cloud opens from the page by its id alone: the team comes from the verified session, and opens as the switcher opens it", async () => {
  const f = preload();
  await f.bridge.cloudAccount.openTeam({ toString: () => "team-acme" }, { origin: "https://evil.example.test" });
  assert.deepEqual(f.invoked, [["cloud-account:openTeam", "team-acme"]]);
  const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8"), start = source.indexOf("const workspaceOnly ="), end = source.indexOf('ipcMain.handle("organization:settings-opened"', start);
  const handlers = new Map(), shown = [], cancelled = [], frame = { url: `${origin}/` }, contents = { mainFrame: frame };
  const acme = { id: "team-acme", name: "Acme", role: "member", machine: { status: "ready", origin: "https://omb-t-2.fly.dev" } };
  let state = { status: "connected", teams: [acme] };
  localOrigin.setLocalOrigin(origin);
  const context = vm.createContext({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    localOnly: localOrigin.localOnly, workspaceSenderAllowed: environments.workspaceSenderAllowed, mainWindow: { webContents: contents },
    rendererOrigin: () => origin, environmentsState: { environments: [], activeId: "local" }, ensureCloudAccount: () => ({ state: () => state }),
    homeWindow: { cancel: () => cancelled.push(1) },
    showHome: async options => { shown.push(JSON.parse(JSON.stringify(options))); } });
  vm.runInContext(source.slice(start, end), context);
  const open = handlers.get("cloud-account:openTeam"), page = { sender: contents, senderFrame: frame };
  await open(page, "team-acme");
  assert.deepEqual(shown, [{ place: { team: "team-acme", name: "Acme" } }]);
  assert.equal(cancelled.length, 1, "a team chosen from the page takes the window back from any recovery");
  await assert.rejects(async () => open(page, "team-other"), /not in that team/);
  state = { status: "unavailable", teams: [acme] };
  await assert.rejects(async () => open(page, "team-acme"), /not in that team/, "only a connected session's teams");
  assert.throws(() => open({ sender: contents, senderFrame: { url: "https://remote.example.test" } }, "team-acme"), /only available/);
  assert.equal(shown.length, 1);
});

test("Cancel and Keep my plan from Settings carry only the survey's words, and only the exact local main frame may ask", async () => {
  const f = preload();
  await f.bridge.cloudAccount.cancelPlan({ answer: "price", expected: "words" }, { origin: "https://evil.example.test" });
  await f.bridge.cloudAccount.cancelPlan();
  await f.bridge.cloudAccount.keepPlan({ cloudId: "someone-elses" });
  assert.deepEqual(f.invoked, [["cloud-account:cancelPlan", { answer: "price", expected: "words" }], ["cloud-account:cancelPlan", null], ["cloud-account:keepPlan"]]);
  const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8"), start = source.indexOf("const workspaceOnly ="), end = source.indexOf('ipcMain.handle("organization:settings-opened"', start);
  const handlers = new Map(), calls = [], frame = { url: `${origin}/` }, contents = { mainFrame: frame };
  localOrigin.setLocalOrigin(origin);
  const context = vm.createContext({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    localOnly: localOrigin.localOnly, workspaceSenderAllowed: environments.workspaceSenderAllowed, mainWindow: { webContents: contents },
    rendererOrigin: () => origin, environmentsState: { environments: [], activeId: "local" },
    ensureCloudAccount: () => ({ cancelPlan: (...args) => { calls.push(["cancelPlan", ...args]); return { outcome: "cancelled" }; },
      keepPlan: (...args) => { calls.push(["keepPlan", ...args]); return { outcome: "kept" }; } }) });
  vm.runInContext(source.slice(start, end), context);
  const page = { sender: contents, senderFrame: frame };
  await handlers.get("cloud-account:cancelPlan")(page, { answer: "setup" }, "https://evil.example.test");
  await handlers.get("cloud-account:keepPlan")(page, "anything");
  assert.deepEqual(calls, [["cancelPlan", { answer: "setup" }], ["keepPlan"]]);
  for (const channel of ["cloud-account:cancelPlan", "cloud-account:keepPlan"]) {
    for (const sender of [{ sender: contents, senderFrame: { url: `${origin}/subframe` } }, { sender: {}, senderFrame: frame },
      { sender: contents, senderFrame: { url: "https://remote.example.test" } }]) assert.throws(() => handlers.get(channel)(sender, { answer: "price" }), /only available/);
  }
  assert.equal(calls.length, 2);
});
