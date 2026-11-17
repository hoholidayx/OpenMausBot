import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";

const MODEL = "fixture/context";
const REPORTED_WINDOW = 200_000;
// Long enough that three exchanges are a few hundred tokens of transcript.
const LINE = "Keep the quarterly report in the shared folder, name each chart after its source table, and say which figures changed since the last draft. ";
const ASKS = ["FIRST", "SECOND", "THIRD", "FOURTH"].map((label) => `${label} ${LINE}${LINE}`);

let url = "";
let usageFile = "";
let updatesFile = "";

const control = (...args: string[]) => runControlOmb([...args, "--url", url]) as Promise<any>;
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(url + path, {
    method, headers: { "content-type": "application/json", origin: url },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
  });
  return { status: response.status, body: await response.json() as any };
};
/** What the agent reports before each prompt result: nothing, or these sizes. */
const reports = (...used: number[]) => writeFileSync(usageFile, JSON.stringify(used));
type BotRef = { id: string; activeTaskId: string };

const selectAcp = (bot: BotRef) => control("set-model", "--bot", bot.id, "--instance", "opencodeGo", "--model", MODEL);
const acpBot = async (name: string) => {
  const { bot } = await control("new-bot", "--name", name) as { bot: BotRef };
  await selectAcp(bot);
  return bot;
};
const taskOf = async (bot: BotRef) => (await api("GET", "/api/bots")).body.bots
  .find((entry: any) => entry.id === bot.id).tasks.find((entry: any) => entry.threadId === bot.activeTaskId);
const messagesOf = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).body.messages as any[];
const sendTo = async (bot: BotRef, text: string) => {
  await control("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", text);
  expect((await control("wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "30")).status).toBe("settled");
};

/** One fresh 1:1 conversation of four asks: how many compaction records it
 * holds after each, and the context the conversation shows at the end. */
async function conversation(name: string, ...used: number[]) {
  reports(...used);
  const bot = await acpBot(name);
  const compactions: number[] = [];
  for (const text of ASKS) {
    await sendTo(bot, text);
    const messages = await messagesOf(bot.activeTaskId);
    compactions.push(messages.filter((message) => message.kind === "compaction").length);
  }
  return { compactions, context: (await taskOf(bot)).usage?.context };
}

async function withAcpServer(run: (fixture: { dataDir: string; restart: (whileStopped?: () => void) => Promise<void> }) => Promise<void>): Promise<void> {
  const fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, { scripted: true });
  const { dataDir, logPath } = fixture.info;
  let server: ChildProcess = fixture.child;
  const restart = async (whileStopped?: () => void) => {
    await waitForExit(server, { signal: "SIGTERM" });
    whileStopped?.();
    const log = openSync(logPath, "a", 0o600);
    try {
      server = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: verificationServerEnvironment({ FAKE_CLAUDE_CONTEXT_TOKENS: "990000", OMB_WARM_SUMMARY_TIME_SCALE: "0.001" },
          dataDir, Number(new URL(url).port)), stdio: ["ignore", log, log],
      });
    } finally { closeSync(log); }
    await expect.poll(async () => {
      try { return (await fetch(url + "/api/health", { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
    }, { timeout: 20_000 }).toBe(true);
  };
  try {
    url = fixture.info.url;
    usageFile = join(dataDir, "acp-usage.json");
    updatesFile = join(dataDir, "acp-updates.json");
    reports();
    writeFileSync(updatesFile, "[]");
    await restart(() => {
      const configPath = join(dataDir, "config.json");
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      config.instances.opencodeGo = {
        driver: "opencodeGo", displayName: "Context fixture",
        config: { cli: fileURLToPath(new URL("./testing/fake-acp-cli.ts", import.meta.url)) },
        environment: { FAKE_ACP_MODELS: MODEL, FAKE_ACP_USAGE_UPDATES_FILE: usageFile, FAKE_ACP_UPDATES_FILE: updatesFile,
          FAKE_ACP_DUMP: join(dataDir, "acp-dump.json"), FAKE_ACP_DUMP_PROMPT: "1", FAKE_ACP_RPC_APPEND_FILE: join(dataDir, "acp-rpc.jsonl") },
      };
      writeFileSync(configPath, JSON.stringify(config));
    });
    await run({ dataDir, restart });
  } finally {
    await waitForExit(server, { signal: "SIGTERM" });
    await fixture.close();
  }
}

it("shows ACP usage and leaves compaction to the agent regardless of the host threshold", () => withAcpServer(async () => {
  expect((await api("PATCH", "/api/config", { context: { compactAt: 100 } })).status).toBe(200);
  const quiet = await conversation("Quiet agent");
  const full = await conversation("Nearly full agent", 190_000);
  const empty = await conversation("Nearly empty agent", 10);
  expect(quiet.compactions).toEqual([0, 0, 0, 0]);
  expect(full.compactions).toEqual(quiet.compactions);
  expect(empty.compactions).toEqual(quiet.compactions);
  expect(quiet.context).toBeUndefined();
  expect(full.context).toEqual({ tokens: 190_000, window: REPORTED_WINDOW });
  expect(empty.context).toEqual({ tokens: 10, window: REPORTED_WINDOW });
}), 180_000);

it("resumes across an unapplied host summary and recovers from raw history after a session is lost", () => withAcpServer(async ({ dataDir, restart }) => {
  reports(190_000);
  const bot = await acpBot("Archive bot");
  await sendTo(bot, `HISTORY_BEYOND_BUDGET ${LINE.repeat(30)}`);
  await sendTo(bot, "ORIGINAL_ALPHA");
  await sendTo(bot, "ORIGINAL_BETA");
  const history = await messagesOf(bot.activeTaskId);
  const [, first, kept] = history.filter(message => message.role === "user");
  const compacted = { id: randomUUID(), at: Date.now(), kind: "compaction", role: "bot", parentId: history.at(-1).id,
    compaction: { summary: "LEGACY_SUMMARY_SENTINEL", firstKeptId: kept.id, foldedThroughId: first.id,
      legacyMemoryExcluded: true, tokensBefore: 180_000, by: "harness" } };
  await restart(() => {
    const database = new DatabaseSync(join(dataDir, "messages.db"));
    try {
      database.prepare("INSERT INTO messages (thread_id, id, at, role, kind, json) VALUES (?, ?, ?, ?, ?, ?)")
        .run(bot.activeTaskId, compacted.id, compacted.at, compacted.role, compacted.kind, JSON.stringify(compacted));
      database.prepare("UPDATE thread_state SET active_leaf_id = ? WHERE thread_id = ?").run(compacted.id, bot.activeTaskId);
    } finally { database.close(); }
  });

  expect(await api("POST", `/api/bots/${bot.id}/compact`, { threadId: bot.activeTaskId })).toMatchObject({
    status: 409, body: { code: "provider_managed_context" },
  });
  const rpcPath = join(dataDir, "acp-rpc.jsonl");
  const promptPath = join(dataDir, "acp-dump.json.prompt.json");
  const rpc = () => readFileSync(rpcPath, "utf8").trim().split("\n").map(line => JSON.parse(line) as { method: string; sessionId?: string });
  const previous = rpc().findLast(row => row.method === "session/prompt")?.sessionId;
  expect(previous).toBeTruthy();
  const beforeResume = rpc().length;
  await sendTo(bot, "CONTINUE_GAMMA");
  expect(rpc().slice(beforeResume)).toContainEqual(expect.objectContaining({ method: "session/load", sessionId: previous }));
  const continued = readFileSync(promptPath, "utf8");
  expect(continued).toContain("CONTINUE_GAMMA");
  expect(continued).not.toMatch(/LEGACY_SUMMARY_SENTINEL|ORIGINAL_ALPHA|ORIGINAL_BETA/);
  expect((await messagesOf(bot.activeTaskId)).filter(message => message.kind === "compaction")).toMatchObject([compacted]);

  await restart(() => {
    const configPath = join(dataDir, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.context = { ...config.context, rebuildBytes: 1024 };
    Object.assign(config.instances.opencodeGo.environment, { FAKE_ACP_LOAD_NULL: "1", FAKE_ACP_SESSION_ID: "recovered-acp-session" });
    writeFileSync(configPath, JSON.stringify(config));
  });
  await sendTo(bot, "RECOVER_DELTA");
  const recovered = readFileSync(promptPath, "utf8");
  expect(rpc().findLast(row => row.method === "session/prompt")?.sessionId).toBe("recovered-acp-session");
  expect(recovered).toContain("ORIGINAL_ALPHA");
  expect(recovered).toContain("CONTINUE_GAMMA");
  expect(recovered).toContain("RECOVER_DELTA");
  expect(recovered).not.toMatch(/LEGACY_SUMMARY_SENTINEL|HISTORY_BEYOND_BUDGET/);
}), 120_000);

it("shows an agent's plan in the chat as activity only once plan lines are switched on", () => withAcpServer(async () => {
  writeFileSync(updatesFile, JSON.stringify([{ update: { sessionUpdate: "plan", entries: [
    { content: "Read the brief", priority: "high", status: "in_progress" },
    { content: "Write the tests", priority: "medium", status: "pending" },
  ] } }]));
  /** One ask in a fresh conversation: the plan rows its transcript holds. */
  const planRows = async (name: string) => {
    const bot = await acpBot(name);
    await control("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "Plan the launch.");
    expect((await control("wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "30")).status).toBe("settled");
    const messages = (await api("GET", `/api/threads/${bot.activeTaskId}/messages?limit=100`)).body.messages as any[];
    return messages.filter((message) => message.kind === "activity" && String(message.tool?.name ?? "").startsWith("Plan:"))
      .map((message) => ({ name: message.tool.name, ok: message.tool.ok }));
  };
  expect(await planRows("Planner, lines off")).toEqual([]);
  expect((await api("PATCH", "/api/config", { features: { acpPlanLines: true } })).status).toBe(200);
  expect(await planRows("Planner, lines on")).toEqual([{ name: "Plan: 0 of 2 done — Read the brief", ok: true }]);
}), 120_000);
