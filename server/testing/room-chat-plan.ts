import { readFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { fixtureChatReply, fixtureChatText, startLoopbackChat, waitForFixtureFile, type ChatFixtureRequest } from "./loopback-chat.ts";

interface Step {
  tool?: string;
  server?: string;
  arguments: unknown;
  expectError?: boolean;
  capture?: Record<string, string>;
  delayMs?: number;
}

interface Plan {
  key?: string;
  match?: string[];
  repeat?: boolean;
  script?: Plan[];
  turns?: Plan[];
  byPrompt?: Array<{ promptIncludes: string; plan: Plan }>;
  steps?: Step[];
  resumeSteps?: Step[];
  reply?: string;
  resumeReply?: string;
  expectSystemIncludes?: string[];
  expectContextIncludes?: string[];
  progress?: string;
  progressAfterGate?: string;
  readyFile?: string;
  gateFile?: string;
  delayMs?: number;
  fail?: boolean;
  failWith?: string;
  failResumed?: boolean;
}

interface ToolResponse {
  result: { isError: boolean; content: Array<{ text: string }> };
}

interface Turn {
  botId: string;
  planKey?: string;
  system: string;
  prompt: { message: { content: string } };
  transcript: string;
  resumed: boolean;
  unplanned?: true;
  tools: string[];
  evidence: Array<ToolResponse | { step: Step; response: ToolResponse }>;
}

interface Pending {
  turn: Turn;
  plan: Plan;
  steps: Step[];
  active?: Step;
  captures: Record<string, string>;
}

function substitute(value: unknown, captures: Record<string, string>): unknown {
  if (typeof value === "string") return value.replace(/\{\{(\w+)\}\}/g, (match, name) => captures[name] ?? match);
  if (Array.isArray(value)) return value.map(item => substitute(item, captures));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, captures)]));
  }
  return value;
}

function toolCall(request: ChatFixtureRequest, step: Step, args: unknown, id: string) {
  const tool = step.tool ?? "coordinate_bots";
  const prefix = `${step.server ?? "agents"}_`;
  const names = request.tools?.map(tool => tool.function.name) ?? [];
  const full = names.includes(prefix + tool) ? prefix + tool : names.find(name => name.endsWith("_" + tool));
  if (full) return fixtureChatReply("", { name: full, args, id });
  if (names.includes(prefix + "use_tool")) {
    return fixtureChatReply("", { name: prefix + "use_tool", args: { name: tool, arguments: args }, id });
  }
  throw new Error(`Fixture tool ${tool} is missing from ${names.join(", ")}`);
}

function recordResult(work: Pending, content: string) {
  const result = JSON.parse(content) as { ok: boolean; result: string };
  const isError = !result.ok || /^(?:Error:|\{"error":)/.test(result.result);
  const response = { result: { isError, content: [{ text: result.result }] } };
  const step = work.active!;
  if (step.tool === "list_room_targets") work.turn.evidence.push(response);
  else work.turn.evidence.push({ step, response });
  if (step.expectError === false && isError) throw new Error(`Unexpected result for ${step.tool ?? "coordinate_bots"}: ${content}`);
  for (const [name, pattern] of Object.entries(step.capture ?? {})) {
    const found = new RegExp(pattern).exec(result.result)?.[1];
    if (!found) throw new Error(`No value for capture ${name} in ${result.result}`);
    work.captures[name] = found;
  }
}

export async function startRoomPlanChat(planPath: string, botIds: ReadonlyMap<string, string>) {
  const turns: Turn[] = [];
  const pending = new Map<string, Pending>();
  let serial = 0;

  function start(request: ChatFixtureRequest): Pending {
    const system = request.messages[0]?.content ?? "";
    const botId = [...botIds].find(([name]) => system.startsWith(`You are ${name},`) || system.includes(`\nYou are ${name},`))?.[1];
    if (!botId) throw new Error("No fixture bot matches the system message");
    const own = request.messages.at(-1)?.content ?? "";
    const text = fixtureChatText(request);
    const resumed = own.includes("Your downstream room requests have settled.");
    const botPlan = (JSON.parse(readFileSync(planPath, "utf8")) as Record<string, Plan>)[botId] ?? {};
    const before = turns.filter(turn => turn.botId === botId);
    const base = botPlan.byPrompt?.find(rule => text.includes(rule.promptIncludes))?.plan ?? botPlan;
    const matches = (candidate: Plan) => candidate.match?.every(item => text.includes(item));
    const entry = botPlan.script?.find(candidate => !candidate.repeat && matches(candidate) && !before.some(turn => turn.planKey === candidate.key))
      ?? botPlan.script?.find(candidate => candidate.repeat && matches(candidate));
    const plan = entry ?? (base.turns ? base.turns[before.length] : base);
    const turn: Turn = {
      botId, planKey: entry?.key, system, prompt: { message: { content: own } }, transcript: text, resumed,
      tools: request.tools?.map(tool => tool.function.name) ?? [], evidence: [],
    };
    turns.push(turn);
    if (!plan || (botPlan.script && !entry)) {
      turn.unplanned = true;
      throw new Error(`Unexpected fixture turn: ${own.slice(-600)}`);
    }
    for (const expected of [...(plan.expectSystemIncludes ?? []), ...(plan.expectContextIncludes ?? [])]) {
      if (!text.includes(expected)) throw new Error(`Missing fixture context: ${expected}`);
    }
    const declared = entry || base.turns || !resumed ? plan.steps : plan.resumeSteps;
    const steps = declared?.slice() ?? [];
    if (request.tools?.some(tool => tool.function.name === "agents_list_room_targets")) {
      steps.unshift({ tool: "list_room_targets", arguments: {} });
    }
    return { turn, plan, steps, captures: {} };
  }

  const chat = await startLoopbackChat(async (request, signal, progress) => {
    if (!request.stream) return fixtureChatReply("");
    const latest = request.messages.at(-1);
    const id = request.messages.findLast(message => message.role === "tool")?.tool_call_id;
    const previous = id ? pending.get(id) : undefined;
    const work = previous ?? start(request);
    if (latest?.role === "tool") {
      if (!previous) throw new Error(`Unexpected fixture tool result: ${id}`);
      recordResult(work, latest.content ?? "");
    }
    const step = work.steps.shift();
    if (step) {
      if (step.delayMs) await delay(step.delayMs, undefined, { signal });
      if (id) pending.delete(id);
      const nextId = `room-fixture-${++serial}`;
      work.active = step;
      pending.set(nextId, work);
      return toolCall(request, step, substitute(step.arguments, work.captures), nextId);
    }
    const { plan, turn } = work;
    if (plan.progress) progress(plan.progress);
    if (plan.readyFile) writeFileSync(plan.readyFile, "ready");
    if (plan.gateFile) await waitForFixtureFile(plan.gateFile, signal);
    if (plan.progressAfterGate) progress(plan.progressAfterGate);
    if (plan.delayMs) await delay(plan.delayMs, undefined, { signal });
    if (plan.failWith || (plan.fail && !turn.resumed) || (plan.failResumed && turn.resumed)) {
      throw new Error(plan.failWith ?? "Scripted addressed agent failure");
    }
    const reply = turn.resumed && !plan.key ? plan.resumeReply ?? "Summary." : plan.reply ?? "Done.";
    return fixtureChatReply(String(substitute(reply, work.captures)));
  });
  return { ...chat, turns };
}
