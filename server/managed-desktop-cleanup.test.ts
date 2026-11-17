import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "@typescript/typescript6";
import { expect, it } from "vitest";
import { changedInstanceIds, engineLaunches } from "./config.ts";

// Runs the real cleanup functions sliced from index.ts: importing index.ts would start a server.
const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
function section(start: string, end: string) {
  // Line-anchored: `function bindTurnComputer(` also matches inside `async function bindTurnComputer(`.
  const lineStart = (marker: string, from: number) => {
    if (from === 0 && source.startsWith(marker)) return 0;
    const at = source.indexOf(`\n${marker}`, from);
    return at < 0 ? -1 : at + 1;
  };
  const from = lineStart(start, 0), to = from < 0 ? -1 : lineStart(end, from + start.length);
  if (from < 0 || to <= from) throw new Error(`Cleanup test section moved: ${start}`);
  return source.slice(from, to);
}
const interruptsCode = ts.transpileModule(
  section("async function interruptDirectThread(", "async function interruptAllDirectThreads("),
  { compilerOptions: { target: ts.ScriptTarget.ESNext } },
).outputText;
const reloadProvidersCode = ts.transpileModule(
  section("/** The engine a bot's process in a conversation runs on", "// Config writes replace the engines they change."),
  { compilerOptions: { target: ts.ScriptTarget.ESNext } },
).outputText;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
function interruptFixture() {
  const started = deferred(), interrupted = deferred();
  const generations = new Map([["first", "initial"]]);
  const approvals = new Set(["first"]);
  const directRequestOwners = new Map<string, { messageId?: string; stopped: boolean; generations: Set<string> }>();
  const interruptCalls: string[] = [], cancelled: string[] = [], revoked: string[] = [], stopAwaiting: string[] = [];
  const patched: Array<[string, string, object]> = [];
  const context = vm.createContext({
    conversationContext: { forget() {} },
    store: {
      taskByThread: () => undefined,
      patchMessage: (threadId: string, messageId: string, patch: object) => patched.push([threadId, messageId, patch]),
    },
    botForThread: () => ({ id: "first" }),
    runningTurnInstance: () => ({ adapter: { interruptTurn: (threadId: string) => {
      interruptCalls.push(threadId);
      started.resolve();
      return interrupted.promise;
    } } }),
    directTurnGenerationByThread: generations,
    directRequestOwners,
    coordinator: { stopAwaitingDirect: (threadId: string) => stopAwaiting.push(threadId) },
    stopParkedCards() {},
    cancelDirectTurnDispatch: (_botId: string, threadId: string) => cancelled.push(threadId),
    revokeInternalCapabilitiesForThread: (threadId: string) => revoked.push(threadId),
    closeOpenApprovals: (threadId: string) => approvals.delete(threadId),
  });
  vm.runInContext(interruptsCode, context, { filename: "index.ts (interrupt fixture)" });
  return {
    approvals, interruptCalls, cancelled, revoked, directRequestOwners, stopAwaiting, patched,
    interrupt: (threadId: string) => context.interruptDirectThread(threadId, threadId) as Promise<void>,
    park: (threadId: string) => context.interruptParkedTurn(threadId, threadId) as Promise<void>,
    started: started.promise,
    finish: interrupted.resolve,
    replace: (threadId: string) => generations.set(threadId, "replacement"),
  };
}

it("interruptDirectThread cannot close a replacement generation's approval after awaiting its adapter", async () => {
  const f = interruptFixture(), interrupted = f.interrupt("first");
  await f.started; f.replace("first"); f.finish(); await interrupted;
  expect(f.approvals.has("first")).toBe(true);
});

it("interruptParkedTurn ends the engine's turn without stopping the request or its teammates", async () => {
  const f = interruptFixture();
  f.directRequestOwners.set("first", { messageId: "m1", stopped: false, generations: new Set(["initial"]) });
  const parked = f.park("first");
  await f.started; f.finish(); await parked;
  expect(f.interruptCalls).toEqual(["first"]);
  expect(f.cancelled).toEqual(["first"]);
  expect(f.revoked).toEqual(["first"]);
  expect(f.approvals.has("first")).toBe(false);
  expect(f.directRequestOwners.get("first")).toMatchObject({ stopped: false });
  expect(f.stopAwaiting).toEqual([]);
  expect(f.patched).toEqual([]);

  const g = interruptFixture();
  g.directRequestOwners.set("first", { messageId: "m1", stopped: false, generations: new Set(["initial"]) });
  const stopped = g.interrupt("first");
  await g.started; g.finish(); await stopped;
  expect(g.directRequestOwners.get("first")).toMatchObject({ stopped: true });
  expect(g.stopAwaiting).toEqual(["first"]);
  expect(g.patched).toEqual([["first", "m1", { requestCancelled: true }]]);
});

it("interruptParkedTurn cannot close a replacement generation's approval after awaiting its adapter", async () => {
  const f = interruptFixture(), parked = f.park("first");
  await f.started; f.replace("first"); f.finish(); await parked;
  expect(f.approvals.has("first")).toBe(true);
});

function reloadFixture() {
  type Thread = { botId: string; threadId: string; engine: string; busy: boolean };
  const threads: Thread[] = [
    { botId: "eli", threadId: "eli-work", engine: "compat", busy: true },
    { botId: "mira", threadId: "mira-work", engine: "claude", busy: true },
    { botId: "eli", threadId: "eli-idle", engine: "compat", busy: false },
    { botId: "mira", threadId: "mira-idle", engine: "claude", busy: false },
  ];
  let configs: Record<string, { driver: string; environment?: Record<string, string> }> = {
    compat: { driver: "openai-compat", environment: { OPENAI_COMPAT_API_KEY: "k1" } },
    claude: { driver: "claudeAgent" },
  };
  // Two rooms, each with a member speaking on one engine and holding a bearer in each.
  const rooms = new Map([["room-compat", { botId: "eli", engine: "compat" }], ["room-claude", { botId: "mira", engine: "claude" }]]);
  const log: string[] = [], settled: Array<{ generation: string; text: string }> = [], revoked: string[] = [];
  const slot = (botId: string) => [`${botId} agents`, { grants: "", token: `t-${botId}` }] as const;
  const bearers = new Map([...threads.map(thread => [thread.threadId, new Map([slot(thread.botId)])] as const),
    ...[...rooms.keys()].map(threadId => [threadId, new Map([slot("eli"), slot("mira")])] as const)]);
  const capabilities = new Map([...threads.filter(thread => thread.busy), ...[...rooms].map(([threadId, room]) => ({ threadId, ...room }))]
    .map(turn => [`cap-${turn.threadId}`, { botId: turn.botId, threadId: turn.threadId }]));
  const context = vm.createContext({
    providerFleetReloading: false, providerInstancesChanging: new Set<string>(),
    providerConfigs: () => configs, changedInstanceIds, engineLaunches: (launched: typeof configs) => engineLaunches(launched, {}),
    decorateHostedProvider: undefined,
    internalCapabilities: capabilities, sessionCredentials: bearers,
    revokeEarlierTurnCapabilities: (threadId: string) => {
      revoked.push(threadId);
      for (const [token, capability] of capabilities) if (capability.threadId === threadId) capabilities.delete(token);
    },
    runningTurnEngines: new Map([...threads.filter(thread => thread.busy), ...[...rooms].map(([threadId, room]) => ({ threadId, ...room }))]
      .map(thread => [thread.threadId, { instanceId: thread.engine }])),
    botForThread: (botId: string) => ({ modelSelection: { instanceId: botId === "eli" ? "compat" : "claude" } }),
    store: {
      bots: [{ id: "eli" }, { id: "mira" }],
      tasks: (botId: string) => threads.filter(thread => thread.botId === botId),
      taskByThread: (_botId: string, threadId: string) => threads.find(thread => thread.threadId === threadId),
      appendMessage: (threadId: string, message: { tool: { name: string } }) => log.push(`message:${threadId}:${message.tool.name}`),
      setTaskActivity: (_botId: string, threadId: string) => { threads.find(thread => thread.threadId === threadId)!.busy = false; },
      groupByThread: (threadId: string) => rooms.has(threadId) ? { id: `group-${threadId}` } : undefined,
      patchGroup() {}, setActivity() {},
    },
    activeGroupSpeaker: () => undefined,
    threadBusy: (_botId: string, threadId: string) => threads.find(thread => thread.threadId === threadId)!.busy,
    groupSpeakers: new Map([...rooms].map(([threadId, room]) => [threadId, { botId: room.botId }])), turnResourceOwners: new Map(threads.map(thread => [thread.threadId, { threadId: thread.threadId, generation: `gen-${thread.threadId}` }])),
    providerAuthSessions: { clearInstance: (id: string) => log.push(`auth:${id}`) },
    bus: { detach: (id: string) => log.push(`detach:${id}`), attach: (instances: Array<{ instanceId: string }>) => log.push(`attach:${instances.map(instance => instance.instanceId)}`) },
    registry: {
      dispose: async (id: string) => { log.push(`dispose:${id}`); },
      load: async (loaded: object) => { log.push(`load:${Object.keys(loaded)}`); },
      get: (id: string) => ({ instanceId: id }),
    },
    cancelDirectTurnDispatch: (_botId: string, threadId: string) => log.push(`cancel:${threadId}`),
    cancelGroupTurnOperations: (_groupId: string, threadId: string, outcome: { status: string; detail: string; byHarness?: boolean }) =>
      log.push(`room-stop:${threadId}:${outcome.status}:${outcome.detail}:${outcome.byHarness === true}`),
    liveTurnByThread: new Map(),
    stoppedTurnText: (threadId: string, _turnId: string | undefined, cause: string) => `${cause} (${threadId})`,
    stoppedTurnOutcome: ({ reason }: { reason: string }) => reason,
    stopScreenPoller() {}, releaseLocalVmThread() {}, releaseTurnResources() {}, endForeignTurns() {}, vpsThreadEnded() {},
    watchdog: { settle() {} }, closeOpenApprovals() {}, directTurnBots: new Map(),
    finalizeDelegationWatch: (_threadId: string, _ok: boolean, _reply: string, why: string) => log.push(`delegation:${why}`),
    routines: { failThread() {} }, failedTurnTool: (name: string) => ({ name, ok: false }),
    settleDirectFollowup: (generation: string, outcome: { text: string }) => settled.push({ generation, text: outcome.text }),
    retryDelegationsWaitingOn() {},
    drainQueuedSends() {},
  });
  vm.runInContext(reloadProvidersCode, context, { filename: "index.ts (provider reload fixture)" });
  const save = (next: typeof configs) => {
    const before = configs;
    configs = next;
    return context.reloadProviders(engineLaunches(before, {})) as Promise<void>;
  };
  const held = () => Object.fromEntries([...bearers].map(([threadId, slots]) => [threadId, [...slots.keys()]]));
  return { threads, log, settled, revoked, held, save, configs: () => configs, context };
}

it("saving the same provider settings again interrupts no turn and replaces no engine", async () => {
  const f = reloadFixture();
  const before = f.held();
  await f.save(structuredClone(f.configs()));
  expect(f.log).toEqual([]);
  expect(f.settled).toEqual([]);
  expect(f.revoked).toEqual([]);
  expect(f.held()).toEqual(before);
  expect(f.threads.filter(thread => thread.busy).map(thread => thread.threadId)).toEqual(["eli-work", "mira-work"]);
});

it("a changed key replaces only its engine and tells only that engine's requesters why", async () => {
  const f = reloadFixture();
  await f.save({ ...f.configs(), compat: { driver: "openai-compat", environment: { OPENAI_COMPAT_API_KEY: "k2" } } });
  expect(f.log.filter(line => line.includes("claude") || line.includes("mira"))).toEqual([]);
  expect(f.revoked).toEqual(["eli-work", "room-compat"]);
  expect(f.held()).toEqual({
    "eli-work": [], "eli-idle": [], "mira-work": ["mira agents"], "mira-idle": ["mira agents"],
    "room-compat": ["mira agents"], "room-claude": ["mira agents"],
  });
  expect(f.log).toEqual(expect.arrayContaining(["auth:compat", "detach:compat", "cancel:eli-work", "load:compat", "attach:compat",
    "message:eli-work:turn interrupted — provider settings changed",
    "room-stop:room-compat:stopped:turn interrupted — provider settings changed:true"]));
  expect(f.settled).toEqual([{ generation: "gen-eli-work", text: "turn interrupted — provider settings changed (eli-work)" }]);
  expect(f.threads.find(thread => thread.threadId === "mira-work")?.busy).toBe(true);
  expect(f.threads.find(thread => thread.threadId === "eli-work")?.busy).toBe(false);
  expect(f.context.providerInstancesChanging.size).toBe(0);
  expect(f.context.providerFleetReloading).toBe(false);
});

it("ends a room stopped by the harness with its cause, and one the person stopped as theirs", () => {
  const run = (outcome?: { status: "stopped"; detail: string; byHarness: true }) => {
    const calls: string[] = [];
    const context = vm.createContext({
      conversationContext: { forget() {} },
      coordinator: {
        cancelRoom: (...args: string[]) => calls.push(`assignments:${args.join("|")}`),
        stopAwaitingDirect: (threadId: string) => { calls.push(`stop-awaiting:${threadId}`); },
      },
      stopParkedCards: (threadId: string) => calls.push(`cards-stopped:${threadId}`),
      roomMemberLock: { releaseThread: (threadId: string) => calls.push(`member-claims:${threadId}`) },
      groupTurnOperations: new Map([["g", new Set([{ threadId: "room", cancellation: new AbortController() }])]]),
      finishGroupGoalRun: (_groupId: string, _operation: unknown, status: string, detail: string) => calls.push(`goal:${status}|${detail}`),
      markCancelledProviderHandshake() {},
    });
    vm.runInContext(ts.transpileModule(section("function cancelGroupTurnOperations(", "function groupProviderHandshakeStarted("),
      { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText, context);
    context.cancelGroupTurnOperations("g", "room", outcome);
    return calls;
  };
  expect(run({ status: "stopped", detail: "Turn interrupted — provider settings changed.", byHarness: true })).toEqual([
    "assignments:g|room|Turn interrupted — provider settings changed.|failed",
    "member-claims:room",
    "goal:stopped|Turn interrupted — provider settings changed.",
  ]);
  expect(run()).toEqual([
    "cards-stopped:room", "stop-awaiting:room",
    "assignments:g|room", "member-claims:room", "goal:stopped|Stopped by you.",
  ]);
});
