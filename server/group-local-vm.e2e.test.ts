import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { writeFileAtomic } from "./atomic.ts";
import { CONTROL_BUSY, CONTROL_REFUSAL_PLAIN, controlRefusal, createControlClient } from "./control-client.ts";
import { freePortBlock } from "./testing/ports.ts";
import { readHandoffs } from "./testing/handoff-rows.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CALL_WAIT_MS = 3_000;
let child: ChildProcess;
let startServer: (computerWaitMaxMs?: number) => Promise<void>;
let fixtureHome = "";
let base = "";
let stateFile = "";
let dumpFile = "";
let finishFile = "";
let stderr = "";
const vmState = (state: Record<string, unknown> = {}) => writeFileAtomic(stateFile, JSON.stringify(state));
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await r.json() as any;
  expect(r.ok, `${method} ${path}: ${JSON.stringify(result)}`).toBe(true);
  return result;
};
async function until<T>(read: () => T | Promise<T>, accept: (value: T) => boolean): Promise<T> {
  const end = Date.now() + 15_000;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() >= end) throw new Error(`Fixture wait expired: ${JSON.stringify(value)}\n${stderr}`);
    await new Promise(r => setTimeout(r, 40));
  }
}
// A poll can land mid-write (macOS CI read truncated JSON): a parse error means "not yet".
const dump = () => until(() => {
  if (!existsSync(dumpFile)) return null;
  try { return JSON.parse(readFileSync(dumpFile, "utf8")); } catch { return null; }
}, Boolean);
const activityRows = async (threadId: string, text: string) => (await api("GET", `/api/threads/${threadId}/messages`)).messages
  .filter((message: any) => message.tool?.name?.includes(text)).length;
// The seeded Chief answers a failed run with a Problems to look at turn on this same engine, and that turn writes the dump.
async function stepDownSeededChief() {
  const seeded = (await api("GET", "/api/bots?messages=0")).bots.find((bot: any) => bot.chiefOfStaff);
  if (seeded) await api("PATCH", `/api/bots/${seeded.id}`, { chiefOfStaff: false });
}
const idle = (botId: string) => until(() => api("GET", "/api/bots?messages=0"), s => !s.bots.find((b: any) => b.id === botId)?.busy);
const computer = (d: any) => d.mcpConfig.mcpServers.computer;
const gate = (c: any) => fetch(c.env.OMB_CONTROL_URL, { headers: { authorization: `Bearer ${c.env.OMB_CONTROL_TOKEN}` } });
const check = (c: any) => createControlClient({ url: c.env.OMB_CONTROL_URL, token: c.env.OMB_CONTROL_TOKEN }).state(true);

beforeAll(async () => {
  fixtureHome = mkdtempSync(join(tmpdir(), "omb-group-vm-"));
  stateFile = join(fixtureHome, "vm.json");
  dumpFile = join(fixtureHome, "dump.json");
  finishFile = join(fixtureHome, "finish");
  vmState();
  const data = join(fixtureHome, "data");
  const ui = join(fixtureHome, "static");
  mkdirSync(data); mkdirSync(join(ui, "assets"), { recursive: true });
  writeFileSync(join(ui, "index.html"), "<title>Isolated VM routing</title>");
  writeFileSync(join(ui, "assets", "test.css"), "body{}");
  writeFileSync(join(data, "config.json"), JSON.stringify({ instances: { claude: {
    driver: "claudeAgent", config: { cli: join(ROOT, "server/testing/fake-claude-cli.ts") },
    environment: { FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_DUMP: dumpFile, FAKE_CLAUDE_SLOW_FINISH_GATE: finishFile, FAKE_CLAUDE_USES_CLOUD_COMPUTER: "1" },
  } } }));
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  startServer = async (computerWaitMaxMs) => {
    // Started as the desktop app starts its own server, which hears the app's driver record over its parent port.
    child = spawn(process.execPath, ["--import", pathToFileURL(join(ROOT, "server/testing/group-local-vm-hooks.mjs")).href,
      "--import", pathToFileURL(join(ROOT, "server/testing/desktop-parent.mjs")).href, join(ROOT, "server/index.ts")], {
      cwd: ROOT, env: {
        PATH: dirname(process.execPath), ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        HOME: fixtureHome, USERPROFILE: fixtureHome, OMB_DATA_DIR: data,
        APPDATA: join(fixtureHome, "appdata"), LOCALAPPDATA: join(fixtureHome, "localappdata"),
        TEMP: fixtureHome, TMP: fixtureHome, TMPDIR: fixtureHome,
        OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1), OMB_STATIC_DIR: ui, OMB_TEST_VM_STATE: stateFile,
        ...(computerWaitMaxMs ? { OMB_COMPUTER_WAIT_MAX_MS: String(computerWaitMaxMs) } : {}),
        OMB_COMPUTER_CALL_WAIT_MS: String(CALL_WAIT_MS),
        OMB_USER_DATA: join(fixtureHome, "user-data"),
      }, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", () => {});
    child.stderr!.on("data", c => { stderr += c; });
    await until(async () => {
      if (child.exitCode !== null) throw new Error(stderr);
      try { return (await fetch(base + "/api/health")).ok; } catch { return false; }
    }, Boolean);
    await stepDownSeededChief();
  };
  await startServer();
});
afterAll(async () => {
  if (stateFile) vmState();
  if (finishFile) writeFileSync(finishFile, "finish");
  await waitForExit(child, { signal: "SIGTERM" });
  if (fixtureHome) await removeTempDir(fixtureHome);
});
afterEach(() => {
  vmState();
  writeFileSync(finishFile, "finish");
});

describe("Local VM stop and resume", () => {
  it("stops an idle shared VM without deleting it, remembers why across restart, and starts it again", async () => {
    vmState({ containers: ["shared"], idleMs: 300 });
    await api("PATCH", "/api/config", { localVm: { mode: "shared", idleTimeoutMinutes: 5 } });
    const { bot } = await api("POST", "/api/bots", { name: "Resume fixture", computer: "vm" });
    await until(() => api("GET", "/api/local-computer"), s => s.container === "stopped");
    expect((await api("GET", "/api/local-computer")).stop_reason).toBe("idle");
    const stopped = JSON.parse(readFileSync(stateFile, "utf8"));
    expect(stopped.containers).toEqual(["shared"]);
    expect(stopped.actions).toEqual([{ action: "stop", target: "shared" }]);
    vmState({ ...stopped, idleMs: 60_000 });
    await waitForExit(child, { signal: "SIGTERM" });
    await startServer();
    expect((await api("GET", `/api/bots/${bot.id}/local-computer`)).stop_reason).toBe("idle");
    const started = await api("POST", "/api/local-computer/start", {});
    expect(started.ready).toBe(true);
    expect((await api("GET", "/api/local-computer")).stop_reason).toBeNull();
    expect(JSON.parse(readFileSync(stateFile, "utf8")).actions).toEqual([
      { action: "stop", target: "shared" }, { action: "start", target: "shared" },
    ]);
    await api("DELETE", `/api/bots/${bot.id}`);
  });

  it("resumes an existing per-bot VM even at the instance cap", async () => {
    vmState({ containers: [] });
    await api("PATCH", "/api/config", { localVm: { mode: "per-bot", maxInstances: 1 } });
    const { bot } = await api("POST", "/api/bots", { name: "Per-bot resume", computer: "vm" });
    await api("POST", `/api/bots/${bot.id}/local-computer/run`, {});
    await api("POST", `/api/bots/${bot.id}/local-computer/stop`, {});
    expect((await api("POST", `/api/bots/${bot.id}/local-computer/start`, {})).ready).toBe(true);
    await api("POST", `/api/bots/${bot.id}/local-computer/stop`, {});
    await api("PATCH", `/api/bots/${bot.id}`, { computer: null, browser: false });
    rmSync(dumpFile, { force: true }); rmSync(finishFile, { force: true });
    await api("POST", `/api/bots/${bot.id}/messages`, { text: "Use the existing computer." });
    expect(computer(await dump())).toBeTruthy();
    writeFileSync(finishFile, "finish");
    await idle(bot.id);
    expect(JSON.parse(readFileSync(stateFile, "utf8")).actions.map((entry: any) => entry.action)).toEqual([
      "run", "stop", "start", "stop", "start",
    ]);
    await api("DELETE", `/api/bots/${bot.id}`);
    await api("PATCH", "/api/config", { localVm: { mode: "shared", maxInstances: 2 } });
  });
});

describe("Local VM ownership on the real isolated server", () => {
  it.each([false, true])("provisions concurrent cold pool seats (existing per-bot desktops: %s)", async (existingPerBot) => {
    vmState({ containers: [] });
    rmSync(dumpFile, { force: true }); rmSync(finishFile, { force: true });
    const bots: any[] = [];
    const readState = () => JSON.parse(readFileSync(stateFile, "utf8"));
    try {
      await api("PATCH", "/api/config", { localVm: { mode: "per-bot", maxInstances: 2 } });
      for (const name of ["Pool first", "Pool second", "Pool waiter"]) {
        const { bot } = await api("POST", "/api/bots", { name });
        await api("PATCH", `/api/bots/${bot.id}`, { computer: "vm", browser: false });
        bots.push(bot);
      }
      if (existingPerBot) {
        for (const bot of bots.slice(0, 2)) await api("POST", `/api/bots/${bot.id}/local-computer/run`, {});
        const capped = await fetch(base + `/api/bots/${bots[2].id}/local-computer/run`, {
          method: "POST", headers: { "content-type": "application/json" }, body: "{}",
        });
        expect(capped.status).toBe(409);
      }
      await api("PATCH", "/api/config", { localVm: { mode: "pool", maxInstances: 2 } });
      vmState({ ...readState(), blockedTarget: "pool:0" });
      rmSync(stateFile + ".entered", { force: true });
      await api("POST", `/api/bots/${bots[0].id}/messages`, { text: "Hold the first seat." });
      await until(() => existsSync(stateFile + ".entered") && readFileSync(stateFile + ".entered", "utf8") === "pool:0", Boolean);
      await api("POST", `/api/bots/${bots[1].id}/messages`, { text: "Hold the second seat." });
      const secondComputer = computer(await dump());
      const secondStatus = await api("GET", `/api/bots/${bots[1].id}/local-computer`);
      expect(secondStatus).toMatchObject({ ready: true, target_key: "pool:1" });
      expect(JSON.stringify(secondComputer)).toContain(secondStatus.container_name);
      expect(readState().blockedTarget).toBe("pool:0");
      expect((await gate(secondComputer)).status).toBe(200);

      rmSync(dumpFile, { force: true });
      vmState({ ...readState(), blockedTarget: undefined });
      const firstComputer = computer(await dump());
      const firstStatus = await api("GET", `/api/bots/${bots[0].id}/local-computer`);
      expect(firstStatus).toMatchObject({ ready: true, target_key: "pool:0" });
      expect(JSON.stringify(firstComputer)).toContain(firstStatus.container_name);
      expect((await gate(firstComputer)).status).toBe(200);
      expect(readState().actions.filter((action: any) => action.target.startsWith("pool:"))).toEqual([
        { action: "run", target: "pool:1" }, { action: "run", target: "pool:0" },
      ]);

      rmSync(dumpFile, { force: true });
      await api("POST", `/api/bots/${bots[2].id}/messages`, { text: "Wait for an available seat." });
      const waitingComputer = computer(await dump());
      void gate(waitingComputer).catch(() => undefined);
      await until(async () => {
        const state = await api("GET", "/api/bots?messages=30");
        return state.bots.find((bot: any) => bot.id === bots[2].id)?.messages
          .some((message: any) => String(message.tool?.name ?? "").startsWith("Waiting for its turn on this computer"));
      }, Boolean);
      const waitingStatus = await api("GET", `/api/bots/${bots[2].id}/local-computer`);
      const holder = waitingStatus.target_key === "pool:0" ? bots[0] : bots[1];
      await api("POST", `/api/bots/${holder.id}/interrupt`, {}); await idle(holder.id);
      expect(JSON.stringify(waitingComputer)).toContain(waitingStatus.container_name);
      expect(readState().containers.filter((key: string) => key.startsWith("pool:")).sort()).toEqual(["pool:0", "pool:1"]);
    } finally {
      vmState({ ...readState(), blockedTarget: undefined });
      writeFileSync(finishFile, "finish");
      for (const bot of bots) {
        await api("POST", `/api/bots/${bot.id}/interrupt`, {}); await idle(bot.id);
        await api("DELETE", `/api/bots/${bot.id}`);
      }
      await api("PATCH", "/api/config", { localVm: { mode: "shared", maxInstances: 2 } });
      vmState();
      await waitForExit(child, { signal: "SIGTERM" });
      await startServer();
    }
  }, 45_000);

  it("recovers only previously provisioned Auto VMs after idle removal and server restart, within the instance cap", async () => {
    vmState({ containers: [] });
    await api("PATCH", "/api/config", { localVm: { mode: "per-bot", maxInstances: 1 } });
    const bots: any[] = [];
    try {
      for (const name of ["Returning VM", "Never had a VM", "Capacity holder"]) {
        const { bot } = await api("POST", "/api/bots", { name });
        await api("PATCH", `/api/bots/${bot.id}`, { browser: false });
        bots.push(bot);
      }
      const [returning, fresh, holder] = bots;
      const created = await api("POST", `/api/bots/${returning.id}/local-computer/run`, {});
      expect(created.workspace_path.startsWith(fixtureHome)).toBe(true);
      const saved = join(created.workspace_path, "saved.txt");
      writeFileSync(saved, "survives idle removal");
      await api("POST", `/api/bots/${returning.id}/local-computer/remove`, {});
      await api("POST", `/api/bots/${holder.id}/local-computer/run`, {});
      await waitForExit(child, { signal: "SIGTERM" });
      await startServer();

      const turn = async (bot: any) => {
        rmSync(dumpFile, { force: true });
        rmSync(finishFile, { force: true });
        await api("POST", `/api/bots/${bot.id}/messages`, { text: "Use the available computer." });
        const mounted = computer(await dump());
        writeFileSync(finishFile, "finish");
        await idle(bot.id);
        return mounted;
      };
      expect(await turn(returning)).toBeUndefined();
      const before = JSON.parse(readFileSync(stateFile, "utf8")).actions.length;
      await api("POST", `/api/bots/${holder.id}/local-computer/remove`, {});
      rmSync(stateFile + ".entered", { force: true });
      expect(await turn(fresh)).toBeUndefined();
      expect(existsSync(stateFile + ".entered")).toBe(false);
      const recovered = await turn(returning);
      expect(recovered).toBeTruthy();
      expect(JSON.stringify(recovered)).toContain(created.container_name);
      expect(readFileSync(saved, "utf8")).toBe("survives idle removal");
      expect(JSON.parse(readFileSync(stateFile, "utf8")).actions.slice(before)).toEqual([
        { action: "remove", target: `bot:${createHash("sha256").update(holder.id).digest("hex")}` },
        { action: "run", target: created.target_key },
      ]);
    } finally {
      writeFileSync(finishFile, "finish");
      for (const bot of bots) {
        await api("POST", `/api/bots/${bot.id}/interrupt`, {});
        await idle(bot.id);
        await api("DELETE", `/api/bots/${bot.id}`);
      }
      await api("PATCH", "/api/config", { localVm: { mode: "shared", maxInstances: 2 } });
      vmState();
      await waitForExit(child, { signal: "SIGTERM" });
      await startServer();
    }
  });

  it("claims an Auto VM on its first shell command without needing a screenshot", async () => {
    vmState(); rmSync(dumpFile, { force: true }); rmSync(finishFile, { force: true });
    const { bot } = await api("POST", "/api/bots", { name: "Auto VM shell" });
    try {
      await api("PATCH", `/api/bots/${bot.id}`, { browser: false });
      await api("GET", "/api/local-computer");
      await api("POST", `/api/bots/${bot.id}/messages`, { text: "Run a command on the VM" });
      const mounted: any = await dump();
      expect(computer(mounted)).toBeTruthy();
      const token = mounted.mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN;
      const response = await fetch(base + "/api/internal/vm-exec", {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ command: "printf auto" }),
      });
      expect(response.status, await response.text()).toBe(200);
      expect(JSON.parse(readFileSync(stateFile + ".exec", "utf8")).command).toBe("printf auto");
    } finally {
      await api("POST", `/api/bots/${bot.id}/interrupt`, {}); await idle(bot.id);
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it.each(["stop", "failure", "off", "manual-selection", "new-request"])("does not continue a computer selection after %s", async failure => {
    vmState(); rmSync(dumpFile, { force: true }); rmSync(finishFile, { force: true });
    const { bot } = await api("POST", "/api/bots", { name: `Computer selection ${failure}` });
    try {
      await api("PATCH", `/api/bots/${bot.id}`, { computer: failure === "off" ? "off" : "browser", browser: false });
      await api("POST", `/api/bots/${bot.id}/messages`, { text: "Open Chrome on the VM" });
      const sent: any = await dump();
      const token = sent.mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN;
      const selected = await fetch(base + "/api/internal/computer/select", { method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ surface: "vm" }) });
      expect(selected.status).toBe(failure === "off" ? 403 : 200);
      rmSync(dumpFile, { force: true });
      if (failure === "failure") process.kill(sent.pid, "SIGKILL");
      else if (failure === "manual-selection") {
        const changing = await fetch(base + `/api/bots/${bot.id}/tasks/${bot.threadId}`, { method: "PATCH",
          headers: { "content-type": "application/json" }, body: JSON.stringify({ surface: "browser" }) });
        expect(changing.status).toBe(409);
        await api("POST", `/api/bots/${bot.id}/interrupt`, {}); await idle(bot.id);
        await api("PATCH", `/api/bots/${bot.id}/tasks/${bot.threadId}`, { surface: "browser" });
      } else if (failure === "new-request") {
        const text = "Forget the VM request. Just answer this new question.";
        const queued = await api("POST", `/api/bots/${bot.id}/messages`, { text });
        expect(queued.queued).toBe(true);
        writeFileSync(finishFile, "finish");
        const next: any = await dump();
        expect(computer(next)).toBeUndefined();
        expect(next.mcpConfig.mcpServers.agents.env.OMB_THREAD_ID).toBe(bot.threadId);
        expect(next.prompt.message.content).toContain(text);
        expect(next.prompt.message.content).not.toContain("The computer selection is now");
      } else await api("POST", `/api/bots/${bot.id}/interrupt`, {});
      await idle(bot.id);
      if (failure !== "new-request") expect(existsSync(dumpFile)).toBe(false);
      const state = await api("GET", "/api/bots?messages=0");
      expect(state.bots.find((b: any) => b.id === bot.id).tasks[0].surface).toBe(failure === "manual-selection" ? "browser" : undefined);
      if (failure === "new-request") {
        const transcript = await api("GET", `/api/threads/${bot.threadId}/messages?limit=50`);
        expect(transcript.messages.filter((message: any) => message.role === "user" && message.kind === "text")
          .map((message: any) => message.text)).toEqual(["Open Chrome on the VM", "Forget the VM request. Just answer this new question."]);
        expect(state.botQueuedMessages[bot.threadId]).toBeUndefined();
      }
    } finally {
      writeFileSync(finishFile, "finish");
      await api("POST", `/api/bots/${bot.id}/interrupt`, {}); await idle(bot.id);
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("runs successive direct tasks on their pinned Local VM despite a Cloud profile default", async () => {
    vmState();
    const { bot } = await api("POST", "/api/bots", { name: "Pinned Local VM" });
    try {
      await api("PATCH", `/api/bots/${bot.id}`, { computer: "cloud", browser: false });
      for (const text of ["Open Chrome on the Local VM", "Inspect the page title on the same Local VM"]) {
        const { task } = await api("POST", `/api/bots/${bot.id}/tasks`, {});
        await api("PATCH", `/api/bots/${bot.id}/tasks/${task.threadId}`, { surface: "vm" });
        rmSync(dumpFile, { force: true }); rmSync(finishFile, { force: true });
        await api("POST", `/api/bots/${bot.id}/messages`, { text, threadId: task.threadId });
        const sent = await dump() as { systemPrompt: string };
        expect(sent.systemPrompt).toContain("Local VM");
        expect(sent.systemPrompt).not.toContain("You can act on the user's computer");
        const c = computer(sent);
        expect(c).toBeTruthy();
        expect(c.args.some((arg: string) => arg.includes("container-mcp"))).toBe(true);
        expect((await gate(c)).status).toBe(200);
        expect((await api("GET", `/api/bots/${bot.id}/computer?threadId=${task.threadId}`)).surface).toBe("vm");
        writeFileSync(finishFile, "finish");
        await until(() => api("GET", "/api/bots?messages=0"), state => !state.bots.find((b: any) => b.id === bot.id)?.tasks.find((t: any) => t.threadId === task.threadId)?.busy);
        expect((await gate(c)).status).toBe(401);
      }
    } finally {
      writeFileSync(finishFile, "finish");
      await api("POST", `/api/bots/${bot.id}/interrupt`, {});
      await idle(bot.id);
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it.each(["shared", "per-bot"])("recovers a direct %s VM after a missing completion", async (mode) => {
    vmState();
    await api("PATCH", "/api/config", { localVm: { mode, maxInstances: 2 } });
    const { bot } = await api("POST", "/api/bots", { name: `Stalled ${mode} VM` });
    try {
      await api("PATCH", `/api/bots/${bot.id}`, { computer: "vm", browser: false });
      rmSync(dumpFile, { force: true }); rmSync(finishFile, { force: true });
      await api("POST", `/api/bots/${bot.id}/messages`, { text: "Hold the VM" });
      const first = computer(await dump());
      expect((await gate(first)).status).toBe(200);
      vmState({ dropCompletion: true, stall: true });
      await until(() => api("GET", "/api/bots?messages=30"), state => JSON.stringify(state).includes("the turn was stopped"));
      await idle(bot.id);
      expect((await gate(first)).status).toBe(401);
      vmState(); rmSync(dumpFile, { force: true });
      const { task } = await api("POST", `/api/bots/${bot.id}/tasks`, {});
      await api("POST", `/api/bots/${bot.id}/messages`, { text: "Use the VM again", threadId: task.threadId });
      const next = computer(await dump());
      expect((await gate(next)).status).toBe(200);
    } finally {
      vmState({ containers: [] }); writeFileSync(finishFile, "finish");
      await api("POST", `/api/bots/${bot.id}/interrupt`, {});
      await idle(bot.id);
      await api("DELETE", `/api/bots/${bot.id}`);
      if (mode === "per-bot") await api("PATCH", "/api/config", { localVm: { mode: "shared", maxInstances: 2 } });
      vmState();
    }
  }, 40_000);

  it.each([["shared", false], ["shared", true], ["per-bot", false], ["per-bot", true]] as const)("keeps a replacement %s VM turn after a late completion (new task: %s)", async (mode, newTask) => {
    vmState();
    await api("PATCH", "/api/config", { localVm: { mode, maxInstances: 2 } });
    const { bot } = await api("POST", "/api/bots", { name: "Late VM completion" });
    try {
      await api("PATCH", `/api/bots/${bot.id}`, { computer: "vm", browser: false });
      rmSync(dumpFile, { force: true }); rmSync(finishFile, { force: true });
      await api("POST", `/api/bots/${bot.id}/messages`, { text: "Hold the VM" });
      const first = computer(await dump());
      rmSync(stateFile + ".latecompleted", { force: true });
      rmSync(stateFile + ".completionheld", { force: true });
      rmSync(stateFile + ".releasecompletion", { force: true });
      vmState({ holdCompletion: true, stall: true });
      await until(() => api("GET", "/api/bots?messages=30"), state => JSON.stringify(state).includes("the turn was stopped"));
      await idle(bot.id);
      await until(() => existsSync(stateFile + ".completionheld"), Boolean);
      expect((await gate(first)).status).toBe(401);
      vmState(); rmSync(dumpFile, { force: true });
      const threadId = newTask ? (await api("POST", `/api/bots/${bot.id}/tasks`, {})).task.threadId : bot.threadId;
      await api("POST", `/api/bots/${bot.id}/messages`, { text: "Keep using the VM", threadId });
      const next = computer(await dump());
      expect(existsSync(stateFile + ".latecompleted")).toBe(false);
      writeFileSync(stateFile + ".releasecompletion", "release");
      await until(() => existsSync(stateFile + ".latecompleted"), Boolean);
      await new Promise(resolve => setTimeout(resolve, 100));
      expect((await gate(next)).status).toBe(200);
      expect((await api("GET", "/api/bots?messages=0")).bots.find((entry: any) => entry.id === bot.id).busy).toBe(true);
    } finally {
      writeFileSync(stateFile + ".releasecompletion", "release");
      vmState({ containers: [] }); writeFileSync(finishFile, "finish");
      await api("POST", `/api/bots/${bot.id}/interrupt`, {});
      await idle(bot.id);
      await api("DELETE", `/api/bots/${bot.id}`);
      if (mode === "per-bot") await api("PATCH", "/api/config", { localVm: { mode: "shared", maxInstances: 2 } });
      vmState();
    }
  }, 30_000);

  // Linux accepts only its own validated runtime descriptor, which a fixture cannot forge.
  it("parks an eager Auto VM wait and resumes with its computer after the holder stops", async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await startServer(2_000);
    vmState({ containers: ["shared"] });
    rmSync(dumpFile, { force: true }); rmSync(finishFile, { force: true });
    const { bot: holder } = await api("POST", "/api/bots", { name: "Eager Auto VM holder", computer: "vm", browser: false });
    const { bot: auto } = await api("POST", "/api/bots", { name: "Eager Auto VM waiter", browser: false });
    try {
      await api("GET", "/api/local-computer");
      await api("POST", `/api/bots/${holder.id}/messages`, { text: "Hold the shared VM" });
      const mountedHolder = computer(await dump());
      expect((await gate(mountedHolder)).status).toBe(200);
      rmSync(dumpFile, { force: true });
      // The container can stop outside the app while its provider turn still holds the seat.
      vmState({ containers: ["shared"], stopped: ["shared"] });
      await api("POST", `/api/bots/${auto.id}/messages`, { text: "Use the stopped shared VM when available" });
      await until(async () => JSON.stringify((await api("GET", `/api/threads/${auto.threadId}/messages`)).messages)
        .includes("Parked — it continues automatically when the computer is free"), Boolean);
      const parked = await until(() => api("GET", "/api/bots?messages=0"), state => {
        const task = state.bots.find((bot: any) => bot.id === auto.id)?.tasks.find((task: any) => task.threadId === auto.threadId);
        return task?.activity === "parked.computer" || existsSync(dumpFile);
      });
      const task = parked.bots.find((bot: any) => bot.id === auto.id).tasks.find((task: any) => task.threadId === auto.threadId);
      expect(task).toMatchObject({ busy: false, activity: "parked.computer" });
      await new Promise(resolve => setTimeout(resolve, 2_500));
      expect(await activityRows(auto.threadId, "Parked — it continues automatically")).toBe(1);
      expect(existsSync(dumpFile)).toBe(false);
      expect(JSON.parse(readFileSync(stateFile, "utf8")).actions ?? []).toEqual([]);
      await api("POST", `/api/bots/${holder.id}/interrupt`, { threadId: holder.threadId });
      await idle(holder.id);
      const resumed = await dump();
      expect(computer(resumed)).toBeTruthy();
      expect(resumed).toMatchObject({ prompt: { message: { content: expect.stringContaining("Continue the task that parked waiting for it") } } });
      expect(JSON.parse(readFileSync(stateFile, "utf8")).actions).toEqual([{ action: "start", target: "shared" }]);
      expect((await gate(computer(resumed))).status).toBe(200);
    } finally {
      for (const bot of [auto, holder]) {
        await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId });
        await idle(bot.id);
        await api("DELETE", `/api/bots/${bot.id}`);
      }
      vmState();
      await waitForExit(child, { signal: "SIGTERM" });
      await startServer();
    }
  }, 60_000);

  it("keeps a turn parked while a person holds the shared VM, and resumes it on the hand-back", async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await startServer(2_000);
    vmState({ containers: ["shared"], stopped: ["shared"] });
    rmSync(dumpFile, { force: true }); rmSync(finishFile, { force: true });
    const { bot } = await api("POST", "/api/bots", { name: "Parked behind a person", computer: "vm", browser: false });
    try {
      await api("GET", "/api/local-computer");
      await api("POST", `/api/bots/${bot.id}/computer/control`, { action: "take" });
      await api("POST", `/api/bots/${bot.id}/messages`, { text: "Use the shared VM after the person" });
      await until(() => activityRows(bot.threadId, "Parked — it continues automatically"), count => count === 1);
      await new Promise(resolve => setTimeout(resolve, 5_000));
      expect(await activityRows(bot.threadId, "Waiting for its turn on this computer")).toBe(1);
      expect(await activityRows(bot.threadId, "Parked — it continues automatically")).toBe(1);
      expect(existsSync(dumpFile)).toBe(false);
      const root = readHandoffs(join(fixtureHome, "data")).findLast(node => node.threadId === bot.threadId)!;
      const db = new DatabaseSync(join(fixtureHome, "data", "runtime.db"), { readOnly: true });
      try {
        expect((db.prepare("SELECT detail FROM assignment_events WHERE assignment_id = ? AND kind = 'held'").all(root.id) as Array<{ detail: string }>).at(-1)?.detail)
          .toBe("waiting for the computer it needs, which another turn or a person is using");
      } finally { db.close(); }
      await api("POST", `/api/bots/${bot.id}/computer/control`, { action: "release" });
      expect(await dump()).toMatchObject({ prompt: { message: { content: expect.stringContaining("Continue the task that parked waiting for it") } } });
    } finally {
      await api("POST", `/api/bots/${bot.id}/computer/control`, { action: "release" });
      await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId });
      await idle(bot.id);
      await api("DELETE", `/api/bots/${bot.id}`);
      vmState();
      await waitForExit(child, { signal: "SIGTERM" });
      await startServer();
    }
  }, 60_000);

  it("runs a screen-less Auto turn to completion while another thread holds the Local VM (issue #1361 AC1)", async () => {
    vmState(); rmSync(dumpFile, { force: true }); rmSync(finishFile, { force: true });
    const { bot: holder } = await api("POST", "/api/bots", { name: "VM holder" });
    const { bot: auto } = await api("POST", "/api/bots", { name: "Screen-less Auto" });
    try {
      await api("PATCH", `/api/bots/${holder.id}`, { computer: "vm" });
      await api("PATCH", `/api/bots/${auto.id}`, { browser: false });
      await api("POST", `/api/bots/${holder.id}/messages`, { text: "Hold the VM" });
      await until(async () => (await api("GET", "/api/bots?messages=0")).bots.find((b: any) => b.id === holder.id)?.busy, Boolean);
      // The dump file is shared with the holder: consume it so the check below reads the Auto turn's own mount.
      await dump();
      rmSync(dumpFile, { force: true });
      await api("POST", `/api/bots/${auto.id}/messages`, { text: "No screen work today" });
      expect(computer(await dump())).toBeTruthy();
      await until(async () => (await api("GET", "/api/bots?messages=0")).bots.find((b: any) => b.id === auto.id)?.busy, Boolean);
      writeFileSync(finishFile, "finish");
      await idle(auto.id); await idle(holder.id);
      const state = await api("GET", "/api/bots?messages=30");
      const activities = (botId: string) => (state.bots.find((b: any) => b.id === botId)?.messages ?? [])
        .filter((m: any) => m.kind === "activity")
        .map((m: any) => m.tool?.name ?? "");
      expect(activities(auto.id).join("|")).not.toContain("Waiting for its turn");
      expect(activities(holder.id).join("|")).not.toContain("Waiting for its turn");
    } finally {
      writeFileSync(finishFile, "finish");
      await api("POST", `/api/bots/${auto.id}/interrupt`, {}); await api("POST", `/api/bots/${holder.id}/interrupt`, {});
      await idle(auto.id); await idle(holder.id);
      await api("DELETE", `/api/bots/${auto.id}`); await api("DELETE", `/api/bots/${holder.id}`);
    }
  });

  it("claims a lazily attached Auto VM on the first screen call and proceeds on release (issue #1361 AC2)", async () => {
    vmState(); rmSync(dumpFile, { force: true }); rmSync(finishFile, { force: true });
    const { bot: auto } = await api("POST", "/api/bots", { name: "Steering Auto" });
    const { bot: holder } = await api("POST", "/api/bots", { name: "VM holder" });
    try {
      await api("PATCH", `/api/bots/${auto.id}`, { browser: false });
      await api("PATCH", `/api/bots/${holder.id}`, { computer: "vm" });
      await api("POST", `/api/bots/${auto.id}/messages`, { text: "Take a screenshot when free" });
      const autoComputer = computer(await dump());
      expect(autoComputer).toBeTruthy();
      rmSync(dumpFile, { force: true });
      await api("POST", `/api/bots/${holder.id}/messages`, { text: "Hold the VM" });
      // busy flips before setup claims the VM; the fresh dump (written after the eager claim and mount) is the sync point.
      const holderComputer = computer(await dump());
      expect(holderComputer).toBeTruthy();
      expect((await gate(holderComputer)).status).toBe(200);
      const started = Date.now();
      const first = await check(autoComputer);
      expect(first).toEqual({ held: true, helpOpen: false, blockedReason: CONTROL_BUSY });
      expect(controlRefusal(first)).not.toBe(CONTROL_REFUSAL_PLAIN);
      expect(Date.now() - started).toBeGreaterThanOrEqual(CALL_WAIT_MS - 200);
      await until(async () => {
 const state = await api("GET", "/api/bots?messages=30");
        return (state.bots.find((b: any) => b.id === auto.id)?.messages ?? [])
          .some((m: any) => m.kind === "activity" && String(m.tool?.name ?? "").startsWith("Waiting for its turn on this computer"));
      }, Boolean);
      await api("POST", `/api/bots/${holder.id}/interrupt`, {}); await idle(holder.id);
      await until(async () => {
        const state = await api("GET", "/api/bots?messages=30");
        return (state.bots.find((b: any) => b.id === auto.id)?.messages ?? [])
          .some((m: any) => m.kind === "activity" && String(m.tool?.name ?? "").startsWith("Computer free"));
      }, Boolean);
      expect(await check(autoComputer)).toEqual({ held: false, helpOpen: false });
    } finally {
      writeFileSync(finishFile, "finish");
      await api("POST", `/api/bots/${auto.id}/interrupt`, {}); await api("POST", `/api/bots/${holder.id}/interrupt`, {});
      await idle(auto.id); await idle(holder.id);
      await api("DELETE", `/api/bots/${auto.id}`); await api("DELETE", `/api/bots/${holder.id}`);
    }
  });

  it("ends the turn with a terminal error after a rejected lazy claim (issues #1361 F1, #1369)", async () => {
    vmState(); rmSync(dumpFile, { force: true }); rmSync(finishFile, { force: true });
    const { bot: chief } = await api("POST", "/api/bots", { name: "Rejected claim chief" });
    await api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true });
    const { bot: auto } = await api("POST", "/api/bots", { name: "Rejected claim Auto" });
    try {
      await api("PATCH", `/api/bots/${auto.id}`, { browser: false });
      await api("POST", `/api/bots/${auto.id}/messages`, { text: "Use the VM when it is ready" });
      const autoComputer = computer(await dump());
      expect(autoComputer).toBeTruthy();
      // The VM dies between dispatch and the first screen call, after bindTurnComputer left an entry behind.
      vmState({ failed: true });
      const refused = { held: true, helpOpen: false,
        blockedReason: expect.stringMatching(/^This turn could not claim the Local VM \(.+\)\. This call was not performed\. Do not retry computer work in this turn/) };
      const first = await check(autoComputer);
      expect(first).toEqual(refused);
      expect(first.blockedReason).not.toContain("Another thread");
      await until(async () => {
        const state = await api("GET", "/api/bots?messages=30");
        return (state.bots.find((b: any) => b.id === auto.id)?.messages ?? [])
          .some((m: any) => m.kind === "activity" &&
            String(m.tool?.name ?? "").startsWith("error: computer unavailable — the Local VM could not be claimed for this turn"));
      }, Boolean);
      await idle(auto.id);
      const incidents = await until(async () => {
        const state = await api("GET", "/api/bots?messages=0");
        const thread = state.bots.find((b: any) => b.id === chief.id)?.tasks?.find((t: any) => t.title === "Problems to look at");
        return thread ? (await api("GET", `/api/threads/${thread.threadId}/messages?limit=100`)).messages : null;
      }, (msgs: any) => Array.isArray(msgs) && msgs.some((m: any) =>
        m.kind === "activity" && String(m.tool?.name ?? "").includes(" hit a problem: ")));
      const chips = incidents.filter((m: any) => m.kind === "activity" && String(m.tool?.name ?? "").includes(" hit a problem: "));
      expect(chips).toHaveLength(1);
      expect(String(chips[0]?.tool?.name)).toContain("computer unavailable — the Local VM could not be claimed for this turn");
      expect(chips[0]?.threadRef?.botId).toBe(auto.id);
      expect((await gate(autoComputer)).status).toBe(401);
    } finally {
      writeFileSync(finishFile, "finish");
      await api("POST", `/api/bots/${auto.id}/interrupt`, {}); await idle(auto.id);
      await api("DELETE", `/api/bots/${auto.id}`);
      await api("POST", `/api/bots/${chief.id}/interrupt`, {}); await idle(chief.id);
      await api("DELETE", `/api/bots/${chief.id}`);
    }
  });

  it("lets an uncontended first screen call through with an honest answer (issue #1361 AC3)", async () => {
    vmState(); rmSync(dumpFile, { force: true }); rmSync(finishFile, { force: true });
    const { bot: auto } = await api("POST", "/api/bots", { name: "Free VM Auto" });
    try {
      await api("PATCH", `/api/bots/${auto.id}`, { browser: false });
      await api("POST", `/api/bots/${auto.id}/messages`, { text: "Take a screenshot" });
      const autoComputer = computer(await dump());
      expect(autoComputer).toBeTruthy();
      expect(await (await gate(autoComputer)).json()).toEqual({ held: false, helpOpen: false });
      const state = await api("GET", "/api/bots?messages=30");
      const activities = (state.bots.find((b: any) => b.id === auto.id)?.messages ?? [])
        .filter((m: any) => m.kind === "activity").map((m: any) => m.tool?.name ?? "");
      expect(activities.join("|")).not.toContain("Waiting for its turn");
    } finally {
      writeFileSync(finishFile, "finish");
      await api("POST", `/api/bots/${auto.id}/interrupt`, {}); await idle(auto.id);
      await api("DELETE", `/api/bots/${auto.id}`);
    }
  });

  it("releases everything a rejected lazy claim took, so the next turn gets the VM (issue #1361 F2)", async () => {
    vmState(); rmSync(dumpFile, { force: true }); rmSync(finishFile, { force: true });
    const { bot: auto } = await api("POST", "/api/bots", { name: "Rejected then idle" });
    const { bot: next } = await api("POST", "/api/bots", { name: "Next VM user" });
    try {
      await api("PATCH", `/api/bots/${auto.id}`, { browser: false });
      await api("PATCH", `/api/bots/${next.id}`, { computer: "vm" });
      await api("POST", `/api/bots/${auto.id}/messages`, { text: "Use the VM" });
      const autoComputer = computer(await dump());
      vmState({ failed: true });
      expect((await (await gate(autoComputer)).json() as any).held).toBe(true);
      vmState();
      rmSync(dumpFile, { force: true });
      await api("POST", `/api/bots/${next.id}/messages`, { text: "Hold the VM" });
      expect(computer(await dump())).toBeTruthy();
      await until(async () => (await api("GET", "/api/bots?messages=0")).bots.find((b: any) => b.id === next.id)?.busy, Boolean);
      const state = await api("GET", "/api/bots?messages=30");
      const activities = (state.bots.find((b: any) => b.id === next.id)?.messages ?? [])
        .filter((m: any) => m.kind === "activity").map((m: any) => m.tool?.name ?? "");
      expect(activities.join("|")).not.toContain("Waiting for its turn");
    } finally {
      writeFileSync(finishFile, "finish");
      await api("POST", `/api/bots/${auto.id}/interrupt`, {}); await api("POST", `/api/bots/${next.id}/interrupt`, {});
      await idle(auto.id); await idle(next.id);
      await api("DELETE", `/api/bots/${auto.id}`); await api("DELETE", `/api/bots/${next.id}`);
    }
  });
});
