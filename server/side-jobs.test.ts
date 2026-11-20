import { describe, expect, it } from "vitest";

import type { TextGenerationOptions } from "./contracts.ts";
import { createSideJobs, type SideJob, type SideJobInstance, type SideJobsDeps } from "./side-jobs.ts";

type Booked = { row: Parameters<SideJobsDeps["book"]>[0]; tokensReported: boolean; notificationThreadId: string };

const models = { default: "x-large", options: [{ id: "x-large", label: "X large" }, { id: "x-mini", label: "X mini" }] };
const allJobs: SideJob[] = ["skill-review", "setup-suggestions", "representative", "status-reply"];

function engine(instanceId: string, driverKind: string, textCall?: "generateText" | "generateMemoryText",
  quickModelsUsable?: SideJobInstance["quickModelsUsable"]) {
  const calls: Array<{ prompt: string; options?: TextGenerationOptions }> = [];
  const state = { reply: () => `${instanceId} wrote this` };
  const generate = async (prompt: string, options?: TextGenerationOptions) => {
    calls.push({ prompt, options });
    const reply = state.reply();
    options?.onUsage?.({ model: options.model ?? `${instanceId}-small`, input: 120, output: 30, costUsd: 0.002 });
    return reply;
  };
  const instance: SideJobInstance = {
    instanceId, driverKind, models, quickModelsUsable, adapter: { capabilities: { agentsMcp: true } },
    ...(textCall === "generateText" ? { generateText: generate } : {}),
    ...(textCall === "generateMemoryText" ? { generateMemoryText: generate } : {}),
  };
  return { instance, calls, state };
}

function setup(options: { modelAllowed?: SideJobsDeps["modelAllowed"]; quickModelsUsable?: boolean } = {}) {
  const claude = engine("claude", "claudeAgent", "generateText");
  const api = engine("api", "openai-compat", "generateText", () => options.quickModelsUsable !== false);
  const codex = engine("codex", "codex", "generateMemoryText");
  const acp = engine("acp", "grokAgent", "generateMemoryText");
  const instances = new Map([claude, api, codex, acp, engine("pi", "piAgent"), engine("muse", "museCode")].map(({ instance }) => [instance.instanceId, instance]));
  const state = { overBudget: false, refused: new Set<string>(), booked: [] as Booked[], logs: [] as string[] };
  const smallModels = new Map<string, Set<string>>();
  const jobs = createSideJobs({
    bot: (id) => id === "missing-bot" ? undefined : { id, name: `Bot ${id}`, threadId: `main-${id}`, modelSelection: { instanceId: id, model: "x-large" } },
    instance: (id) => instances.get(id),
    refusal: (instance) => state.refused.has(instance.instanceId) ? "engine is not allowed" : undefined,
    modelAllowed: options.modelAllowed,
    smallModels: {
      refused: (id) => smallModels.get(id) ?? new Set(),
      remember: (id, model) => smallModels.set(id, new Set([...(smallModels.get(id) ?? []), model])),
    },
    assertWithinBudget: () => {
      if (state.overBudget) throw new Error("this workspace has reached its monthly spend limit");
    },
    book: (row, tokensReported, notificationThreadId) => state.booked.push({ row, tokensReported, notificationThreadId }),
    log: (line) => state.logs.push(line),
  });
  return { jobs, state, claude, api, codex, acp };
}

describe("which engine writes a side job", () => {
  it("books Dream to the selected bot model and leaves a capped job unstarted", async () => {
    const { jobs, codex, state } = setup();
    codex.state.reply = () => '{"calls":[]}';
    const request = { system: "criteria", input: "history", checkpoint() {}, execute: () => "ok" };
    const write = jobs.dream("codex")!;
    await write(request, new AbortController().signal);
    expect(codex.calls[0].options?.model).toBe("x-large");
    expect(state.booked[0].row).toMatchObject({ botId: "codex", model: "x-large", input: 120, output: 30, threadId: expect.stringMatching(/^dream-/) });
    state.overBudget = true;
    await expect(write(request, new AbortController().signal)).rejects.toThrow(/spend limit/);
    expect(codex.calls).toHaveLength(1);
    expect(jobs.dream("missing-bot")).toBeNull();
  });
  it("uses the bot's engine when it supplies one-off text", async () => {
    const { jobs, claude, api, state } = setup();
    for (const job of allJobs) await expect(jobs.text(job, "claude")?.generateText(job)).resolves.toBe("claude wrote this");
    expect(claude.calls.map((call) => call.prompt)).toEqual(allJobs);
    expect(api.calls).toEqual([]);
    expect(state.booked.map((entry) => entry.row.instanceId)).toEqual(["claude", "claude", "claude", "claude"]);
  });

  it("leaves the callers their fallbacks when the bot has no writer", () => {
    const { jobs } = setup();
    for (const job of allJobs) {
      for (const id of ["pi", "muse", "missing-bot", "missing-engine"]) expect(jobs.text(job, id), `${id} ${job}`).toBeNull();
    }
  });

  it.each(["codex", "acp"] as const)("uses %s's own background call for skill review only", async (id) => {
    const fixture = setup();
    const { jobs, claude } = fixture;
    await expect(jobs.text("skill-review", id)?.generateText("review")).resolves.toBe(`${id} wrote this`);
    for (const job of allJobs.filter(job => job !== "skill-review")) expect(jobs.text(job, id), job).toBeNull();
    expect(fixture[id].calls.map((call) => call.prompt)).toEqual(["review"]);
    expect(claude.calls).toEqual([]);
  });

  it("checks engine policy and the skill review's tool capability", () => {
    const { jobs, state, claude } = setup();
    state.refused.add("api");
    for (const job of allJobs) expect(jobs.text(job, "api")).toBeNull();
    claude.instance.adapter.capabilities.agentsMcp = false;
    expect(jobs.text("skill-review", "claude")).toBeNull();
  });
});

describe("setup suggestion model choice", () => {
  it("uses the engine's fast model and the Claude one-shot default", async () => {
    const { jobs, api, claude } = setup();
    await jobs.text("setup-suggestions", "api")!.generateText("choices");
    await jobs.text("setup-suggestions", "claude")!.generateText("choices");
    expect(api.calls[0]?.options?.model).toBe("x-mini");
    expect(claude.calls[0]?.options?.model).toBeUndefined();
  });

  it("leaves model selection to the engine when its fast model cannot be used", async () => {
    for (const options of [{ quickModelsUsable: false }, { modelAllowed: () => false }]) {
      const { jobs, api } = setup(options);
      await jobs.text("setup-suggestions", "api")!.generateText("choices");
      expect(api.calls[0]?.options?.model).toBeUndefined();
    }
  });

  it("skips a fast model the engine already refused", async () => {
    const { jobs, api } = setup();
    api.state.reply = () => { throw new Error("400 invalid_request_error: model x-mini is not available"); };
    await expect(jobs.text("setup-suggestions", "api")!.generateText("choices")).rejects.toThrow("x-mini");
    api.state.reply = () => "new choices";
    await jobs.text("setup-suggestions", "api")!.generateText("choices");
    expect(api.calls.map((call) => call.options?.model)).toEqual(["x-mini", undefined]);
  });
});

describe("side job cancellation and accounting", () => {
  it("forwards cancellation and reads the engine's small-model refusals at each call", async () => {
    const { jobs, codex, state } = setup();
    const signal = new AbortController().signal;
    const review = jobs.text("skill-review", "codex")!;
    await review.generateText("first", { signal });
    const first = codex.calls[0]?.options;
    expect(first?.signal).toBe(signal);
    expect(first?.fallback).toMatchObject({ model: "x-large", refused: new Set() });
    first?.fallback?.onRefused("x-mini");
    await review.generateText("second");
    expect(codex.calls[1]?.options?.fallback?.refused).toEqual(new Set(["x-mini"]));
    expect(state.logs).toEqual([expect.stringContaining("small model x-mini refused on codex")]);
  });

  it("books side jobs to their own engine", async () => {
    const { jobs, state } = setup();
    await jobs.text("setup-suggestions", "api")!.generateText("choices");
    await jobs.text("skill-review", "codex")!.generateText("review");
    expect(state.booked).toEqual([
      { row: expect.objectContaining({ botId: "api", instanceId: "api", model: "x-mini", threadId: expect.stringMatching(/^setup-suggestions-/),
        trigger: { kind: "bot", botId: "api" } }), tokensReported: true, notificationThreadId: "main-api" },
      { row: expect.objectContaining({ botId: "codex", instanceId: "codex", threadId: expect.stringMatching(/^skill-review-/),
        trigger: { kind: "bot", botId: "codex" } }), tokensReported: true, notificationThreadId: "main-codex" },
    ]);
  });

  it("checks the spend limit before each background call", async () => {
    const { jobs, state, claude } = setup();
    state.overBudget = true;
    await expect(jobs.text("skill-review", "claude")!.generateText("review")).rejects.toThrow("monthly spend limit");
    expect(claude.calls).toEqual([]);
    expect(state.booked).toEqual([]);
  });
});
