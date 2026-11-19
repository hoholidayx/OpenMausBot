import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { verificationServerArgs, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { openRuntimeStore, type RuntimeStore } from "./runtime/store.ts";
import { expect, it } from "vitest";
import { fixture } from "./testing/direct-coordination-fixture.ts";

it("traces an ordinary delegated result clipped on its way back to the requester", () => fixture(async f => {
  const reply = "Private fixture material.".repeat(600);
  f.plan[f.lead.id] = { reply };
  await f.start();
  await f.wait();
  const child = f.nodes().find((node: any) => node.botId === f.lead.id);
  expect(child.result).toBe(reply.slice(0, 12_000));
  const trace = readFileSync(f.session.info.logPath, "utf8").split("\n").find(line => line.includes("output_truncation") && line.includes(child.id));
  expect(trace).toBeDefined();
  expect(JSON.parse(trace!.slice(trace!.indexOf("{")))).toMatchObject({ stage: "turn-outcome", assignmentId: child.id,
    threadId: child.threadId, turnId: expect.any(String), originalChars: reply.length, retainedChars: 12_000 });
  expect(trace).not.toContain("Private fixture material");
}), 45000);

it.each(["direct", "relay", "question", "retry", "empty relay"])("delivers bound partner work through %s", mode => fixture(async f => {
  const path = `/api/bots/${f.chief.id}/work-partner`;
  await f.api(path, { expected: null, partnerId: f.lead.id }, "PUT");
  const answer = "The CSV quote escaping was checked.";
  const result = mode === "direct" ? answer.repeat(440) : answer;
  if (mode === "retry") f.plan[f.chief.id].failResumed = true;
  if (mode === "empty relay") f.plan[f.chief.id].resumeReply = "";
  f.plan[f.lead.id] = mode === "question" ? { turns: [
    { reply: "NEEDS INPUT: Which separator should the CSV export use?" }, { reply: answer },
  ] } : { reply: result, ...(["relay", "retry", "empty relay"].includes(mode) ? { steps: [{ tool: "request_partner_relay", arguments: {
    reason: "Please interpret the verification results.",
  } }] } : {}) };
  await f.start();
  const rows = () => f.messages(f.chief.activeTaskId);
  if (mode === "question") {
    const getQuestion = async () => (await rows()).find((r: any) => r.partnerQuestion);
    await expect.poll(getQuestion, { timeout: 15000 }).toBeTruthy();
    const question = await getQuestion();
    await f.api(`/api/threads/${f.chief.activeTaskId}/respond`, { requestId: question.card.requestId, behavior: "answer", message: "Comma" });
  }
  if (mode === "retry") {
    const failed = async () => (await rows()).find((row: any) => row.partnerRelayFailure);
    await expect.poll(failed, { timeout: 12000 }).toBeTruthy();
    const { rootId, attempt } = (await failed()).partnerRelayFailure;
    expect((await rows()).filter((row: any) => row.partnerResultId)).toMatchObject([{ text: result, from: { botId: f.lead.id } }]);
    f.plan[f.chief.id].failResumed = false;
    f.save();
    await f.api(path + "/relay-retry", { rootId, attempt, threadId: f.chief.activeTaskId });
    await expect.poll(async () => (await rows()).some((row: any) => row.text === f.plan[f.chief.id].resumeReply), { timeout: 15000 }).toBe(true);
    expect(f.evidence().filter((turn: any) => turn.botId === f.lead.id)).toHaveLength(1);
  }
  expect((await f.wait()).status).toBe("settled");
  const calls = f.evidence().filter((turn: any) => turn.botId === f.chief.id);
  const replies = (await rows()).filter((row: any) => row.partnerResultId);
  if (mode === "relay" || mode === "retry") {
    expect(replies).toHaveLength(mode === "retry" ? 1 : 0);
    expect(calls).toHaveLength(mode === "retry" ? 3 : 2);
    expect((await rows()).filter((row: any) => row.partnerRelayReceipt)).toHaveLength(1);
    expect((await rows()).some((row: any) => row.text === f.plan[f.chief.id].resumeReply)).toBe(true);
  } else {
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ text: result, from: { botId: f.lead.id } });
    expect(calls).toHaveLength(mode === "empty relay" ? 2 : 1);
  }
}), 60000);

it("continues the original chat while a bound worker runs, keeps its binding snapshot and replays the attributed report once", () => fixture(async f => {
  const gate = join(f.session.info.dataDir, "finish-work");
  const threadId = f.chief.activeTaskId;
  const path = `/api/bots/${f.chief.id}/work-partner`;
  await f.api(path, { expected: null, partnerId: f.lead.id }, "PUT");
  await f.api(`/api/bots/${f.chief.id}`, { parkDirectMessages: true }, "PATCH");
  const answer = "Partner verified CSV specimen 785.";
  f.plan[f.lead.id] = { gateFile: gate, reply: answer };
  f.plan[f.chief.id] = { turns: [f.plan[f.chief.id], { reply: "The other question was received." }, { reply: "I read the report." }] };
  await f.start();
  await expect.poll(async () => (await f.api("/api/bots?messages=0")).bots.find((bot: any) => bot.id === f.chief.id).busy, { timeout: 10000 }).toBe(false);
  await expect.poll(() => f.nodes().find((node: any) => node.parentId)?.status).toBe("running");
  await f.api(path, { expected: f.lead.id, partnerId: null }, "PUT");
  const send = (text: string) => f.api(`/api/bots/${f.chief.id}/messages`, { text, threadId });
  await send("Another question while CSV work is running.");
  await expect.poll(async () => (await f.messages(threadId)).some((row: any) => row.text === "The other question was received."), { timeout: 8000 }).toBe(true);
  writeFileSync(gate, "complete");
  await expect.poll(async () => (await f.messages(threadId)).some((row: any) => row.partnerResultId), { timeout: 8000 }).toBe(true);
  const rows = await f.messages(threadId);
  const result = rows.find((row: any) => row.partnerResultId);
  expect(result.replyToId).toBe(rows.find((row: any) => row.role === "user").id);
  await send("What did the engineer report?");
  await f.wait();
  const turns = f.evidence().filter((turn: any) => turn.botId === f.chief.id);
  expect(turns).toHaveLength(3);
  const prompt = JSON.stringify(turns[2].prompt) + turns[2].system;
  expect(prompt.split(answer)).toHaveLength(2);
  expect(prompt).toContain("Engineering lead");
}), 45000);

it("delivers a requested relay to its original branch after the person switches away", () => fixture(async f => {
  const threadId = f.chief.activeTaskId;
  const botPath = `/api/bots/${f.chief.id}`;
  const gate = join(f.session.info.dataDir, "finish-branch-work");
  const answer = "The original branch's CSV passed.";
  await f.api(botPath + "/work-partner", { expected: null, partnerId: f.lead.id }, "PUT");
  f.plan[f.chief.id] = { turns: [{ reply: "Alternate conversation." }, f.plan[f.chief.id]] };
  f.plan[f.lead.id] = { gateFile: gate, steps: [{ tool: "request_partner_relay", arguments: { reason: "Present the report." } }], reply: answer };
  f.save();
  const { message: alternate } = await f.api(botPath + "/messages", { threadId, text: "Another topic" });
  await f.wait();
  const { message: original } = await f.api(`${botPath}/messages/${alternate.id}/edit`, { threadId, text: "Check CSV with Engineering." });
  await expect.poll(() => f.nodes().some((node: any) => node.partner && node.status === "running")).toBe(true);
  await expect.poll(async () => (await f.messages(threadId)).some((row: any) => row.text === "Assigned to Engineering")).toBe(true);
  const alternateBranch = await f.api(botPath + "/active-branch", { threadId, messageId: alternate.id });
  writeFileSync(gate, "complete");
  const result = async () => (await f.messages(threadId)).find((row: any) => row.partnerResultId);
  await expect.poll(result, { timeout: 8000 }).toBeTruthy();
  const published = await result();
  expect(published).toMatchObject({ text: answer, replyToId: original.id, from: { botId: f.lead.id } });
  expect(await f.api(botPath + "/active-branch", { threadId, messageId: alternate.id })).toEqual(alternateBranch);
  expect((await f.api(botPath + "/active-branch", { threadId, messageId: original.id })).activeLeafId).toBe(published.id);
  expect(f.evidence().filter((turn: any) => turn.botId === f.chief.id)).toHaveLength(2);
}), 45000);

async function restartFixture(f: any, alter: (store: RuntimeStore) => void, check: () => Promise<void>) {
  const { child, info } = f.session;
  const crashed = once(child, "exit");
  child.kill("SIGKILL");
  await crashed;
  const runtime = openRuntimeStore(join(info.dataDir, "runtime.db"));
  try { alter(runtime); } finally { runtime.close(); }
  const env = verificationServerEnvironment({}, info.dataDir, Number(new URL(info.url).port));
  const replacement = spawn(process.execPath, verificationServerArgs(env), { env, stdio: "ignore" });
  try {
    await expect.poll(async () => (await fetch(info.url + "/api/bots").catch(() => null))?.status, { timeout: 15000 }).toBe(200);
    await check();
  } finally {
    const ended = once(replacement, "exit");
    replacement.kill("SIGTERM");
    await ended;
  }
}

it.each(["direct", "relay"])("recovers a committed %s result across a server restart without repeating a model turn", mode => fixture(async f => {
  await f.api(`/api/bots/${f.chief.id}/work-partner`, { expected: null, partnerId: f.lead.id }, "PUT");
  f.plan[f.lead.id] = { reply: "Durable source result", steps: mode === "relay" ? [{ tool: "request_partner_relay", arguments: { reason: "Prepare the final decision" } }] : [] };
  await f.start();
  await f.wait();
  const child = f.nodes().find((row: any) => row.parentId);
  expect(child.partner.delivery).toBe(mode);
  const before = f.evidence().length;
  await restartFixture(f, runtime => {
    const assignment = runtime.get(mode === "direct" ? child.id : child.rootId)!;
    delete assignment.reportedAt;
    if (mode === "relay") {
      assignment.status = "running";
      delete assignment.finishedAt;
      delete assignment.outcome;
    }
    runtime.update(assignment);
  }, async () => {
    await expect.poll(() => f.nodes().find((row: any) => row.id === child.rootId)?.status).toBe("completed");
    await expect.poll(() => f.nodes().find((row: any) => row.id === child.id)?.reported).toBe(true);
    expect(f.evidence()).toHaveLength(before);
    const rows = await f.messages(f.chief.activeTaskId);
    expect(rows.filter((row: any) => mode === "direct" ? row.partnerResultId : row.partnerRelayReceipt)).toHaveLength(1);
  });
}), 45000);


it("delivers an attachment-only result with its original file and keeps it in the next conversation context", () => fixture(async f => {
  const path = `/api/bots/${f.chief.id}/work-partner`;
  await f.api(path, { expected: null, partnerId: f.lead.id }, "PUT");
  const dir = join(f.session.info.dataDir, "workspaces", f.lead.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "report.csv"), "ID,Value\n1,Verified");
  f.plan[f.lead.id] = { steps: [{ tool: "attach_file", arguments: { path: "report.csv" } }], reply: "" };
  await f.start();
  await f.wait();
  const rows = await f.messages(f.chief.activeTaskId);
  const result = rows.find((row: any) => row.partnerResultId);
  expect(result.from.botId).toBe(f.lead.id);
  expect(result.attachments).toMatchObject([{ name: "report.csv" }]);
  f.plan[f.chief.id] = { reply: "Read the file reference" };
  f.save();
  await f.api(`/api/bots/${f.chief.id}/messages`, { text: "Which file came back?", threadId: f.chief.activeTaskId });
  await f.wait();
  const followup = f.evidence().filter((turn: any) => turn.botId === f.chief.id).at(-1);
  expect(JSON.stringify(followup.prompt) + followup.system).toContain("report.csv");
}), 45000);

it.each(["cancel", "lost access"])("withholds a late partner answer after %s", action => fixture(async f => {
  const gate = join(f.session.info.dataDir, "release-worker");
  const threadId = f.chief.activeTaskId;
  await f.api(`/api/bots/${f.chief.id}/work-partner`, { expected: null, partnerId: f.lead.id }, "PUT");
  f.plan[f.lead.id] = { gateFile: gate, reply: "Private pending result" };
  f.save();
  await f.api(`/api/bots/${f.chief.id}/tasks/${threadId}`, { approvalMode: "ask" }, "PATCH");
  const sendId = randomUUID();
  await f.api(`/api/bots/${f.chief.id}/messages`, { text: "Delegate the CSV export", threadId, sendId });
  const route = `/api/bots/${f.chief.id}/requests/${sendId}`;
  const status = () => f.api(route + "?threadId=" + threadId);
  const worker = () => f.nodes().find((node: any) => node.parentId);
  await expect.poll(() => worker()?.status, { timeout: 15000 }).toBe("running");
  expect(worker()?.partner?.messageId).toEqual(expect.any(String));
  if (action === "cancel") {
    await expect.poll(async () => (await status()).phase).toBe("waiting");
    const r = await status();
    await f.api(route + "/interrupt", { threadId, messageId: r.messageId, expectedActiveLeafId: r.activeLeafId,
      expectedTurnId: r.activeTurnId, expectedExecutionId: r.executionId });
  } else {
    await f.api(`/api/bots/${f.lead.id}`, { hidden: true }, "PATCH");
  }
  writeFileSync(gate, "release");
  await expect.poll(() => worker()?.partner?.delivery, { timeout: 10000 }).toBe(action === "cancel" ? "cancelled" : "unavailable");
  expect((await f.messages(threadId)).some((row: any) => row.partnerResultId)).toBe(false);
  expect(f.evidence().filter((turn: any) => turn.botId === f.chief.id)).toHaveLength(1);
}), 45000);

it.each(["settled before delivery", "waiting for the person"])("restarts with partner work %s", state => fixture(async f => {
  await f.api(`/api/bots/${f.chief.id}/work-partner`, { expected: null, partnerId: f.lead.id }, "PUT");
  f.plan[f.lead.id] = { turns: [{ reply: "NEEDS INPUT: Which CSV delimiter?" }, { reply: "Recovered answer" }] };
  await f.start();
  const rows = () => f.messages(f.chief.activeTaskId);
  const question = () => rows().then((history: any[]) => history.find(row => row.partnerQuestion));
  await expect.poll(question, { timeout: 10000 }).toBeTruthy();
  const kid = f.nodes().find((row: any) => row.parentId);
  await restartFixture(f, runtime => {
    if (state === "waiting for the person") return;
    const node = runtime.get(kid.id)!;
    node.status = "completed";
    node.outcome = "done";
    node.finishedAt = Date.now();
    node.result = "Recovered answer";
    delete node.question;
    runtime.update(node);
  }, async () => {
    if (state === "waiting for the person") {
      const body = { requestId: (await question()).card.requestId, behavior: "answer", message: "Comma" };
      await f.api(`/api/threads/${f.chief.activeTaskId}/respond`, body);
    }
    await expect.poll(async () => (await rows()).filter((row: any) => row.partnerResultId).map((row: any) => row.text), { timeout: 12000 }).toEqual(["Recovered answer"]);
    expect((await rows()).filter((row: any) => row.partnerQuestion)).toHaveLength(1);
    expect(f.evidence().filter((turn: any) => turn.botId === f.chief.id)).toHaveLength(1);
  });
}), 45000);

it("restricts each binding to one reachable peer and rejects stale settings writes", () => fixture(async f => {
  const endpoint = `/api/bots/${f.chief.id}/work-partner`;
  const settings = await f.api(endpoint);
  expect(settings.partnerId).toBe(null);
  expect(settings.candidates.map((peer: any) => peer.id)).not.toContain(f.chief.id);
  const put = (expected: string | null, partnerId: string | null) => f.api(endpoint, { expected, partnerId }, "PUT");
  await expect(put(null, f.chief.id)).rejects.toMatchObject({ status: 403 });
  await expect(put(null, "missing")).rejects.toMatchObject({ status: 403 });
  await put(null, f.lead.id);
  await expect(put(null, f.specialist.id)).rejects.toMatchObject({ status: 409 });
  expect((await f.api(`/api/bots/${f.lead.id}/work-partner`)).partnerId).toBe(null);
  await put(f.lead.id, f.specialist.id);
  expect((await put(f.specialist.id, null)).partnerId).toBe(null);
}), 15000);

it("restarts an interrupted relay using the same completed worker result", () => fixture(async f => {
  const gate = join(f.session.info.dataDir, "finish-relay");
  await f.api(`/api/bots/${f.chief.id}/work-partner`, { expected: null, partnerId: f.lead.id }, "PUT");
  f.plan[f.chief.id] = { turns: [f.plan[f.chief.id], { gateFile: gate, reply: "Final relay text" }, { reply: "Final relay text" }] };
  f.plan[f.lead.id] = { steps: [{ tool: "request_partner_relay", arguments: { reason: "Present the joint conclusion" } }], reply: "Worker source" };
  await f.start();
  const root = () => f.nodes().find((node: any) => !node.parentId);
  await expect.poll(() => root()?.status === "running" && root().executions === 2, { timeout: 12000 }).toBe(true);
  await restartFixture(f, () => writeFileSync(gate, "finish"), async () => {
    await expect.poll(() => root()?.status, { timeout: 15000 }).toBe("completed");
    const rows = await f.messages(f.chief.activeTaskId);
    expect(rows.filter((row: any) => row.text === "Final relay text" && row.partnerRelayReceipt)).toHaveLength(1);
    expect(f.nodes().find((node: any) => node.parentId).executions).toBe(1);
  });
}), 45000);

it("publishes a worker's file when the relay fails and replays the delivery once across a restart", () => fixture(async f => {
  const threadId = f.chief.activeTaskId;
  await f.api(`/api/bots/${f.chief.id}/work-partner`, { expected: null, partnerId: f.lead.id }, "PUT");
  const dir = join(f.session.info.dataDir, "workspaces", f.lead.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "verified.csv"), "ID,Value\n1,Verified");
  f.plan[f.chief.id].failResumed = true;
  f.plan[f.lead.id] = { steps: [
    { tool: "attach_file", arguments: { path: "verified.csv" } },
    { tool: "request_partner_relay", arguments: { reason: "Present the verified export" } },
  ], reply: "" };
  await f.start();
  const deliveries = async () => (await f.messages(threadId)).filter((row: any) => row.partnerResultId);
  await expect.poll(deliveries, { timeout: 15000 }).toHaveLength(1);
  const [delivered] = await deliveries();
  expect(delivered).toMatchObject({ from: { botId: f.lead.id }, attachments: [{ name: "verified.csv" }] });
  const root = f.nodes().find((row: any) => !row.parentId);
  const calls = f.evidence().length;
  await restartFixture(f, runtime => {
    const saved = runtime.get(root.id)!;
    delete saved.reportedAt;
    runtime.update(saved);
  }, async () => {
    await expect.poll(() => f.nodes().find((row: any) => row.id === root.id)?.reported).toBe(true);
    expect((await deliveries()).map((row: any) => row.id)).toEqual([delivered.id]);
    expect((await f.messages(threadId)).filter((row: any) => row.partnerRelayFailure)).toHaveLength(1);
    expect(f.evidence()).toHaveLength(calls);
  });
}), 45000);

it("rechecks worker access before publishing a failed relay's fallback", () => fixture(async f => {
  const gate = join(f.session.info.dataDir, "release-failed-relay");
  await f.api(`/api/bots/${f.chief.id}/work-partner`, { expected: null, partnerId: f.lead.id }, "PUT");
  f.plan[f.chief.id] = { turns: [f.plan[f.chief.id], { gateFile: gate, failResumed: true }] };
  f.plan[f.lead.id] = { steps: [{ tool: "request_partner_relay", arguments: { reason: "Summarize findings" } }], reply: "Withheld worker result" };
  await f.start();
  const root = () => f.nodes().find((node: any) => !node.parentId);
  await expect.poll(() => root()?.status === "running" && root().executions === 2, { timeout: 12000 }).toBe(true);
  await f.api(`/api/bots/${f.lead.id}`, { hidden: true }, "PATCH");
  writeFileSync(gate, "release");
  await expect.poll(() => root()?.status, { timeout: 12000 }).toBe("failed");
  const rows = await f.messages(f.chief.activeTaskId);
  expect(rows.some((row: any) => row.partnerResultId || row.partnerRelayFailure || row.text === "Withheld worker result")).toBe(false);
}), 45000);
