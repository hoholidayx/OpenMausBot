import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempDir } from "./testing/cleanup.ts";
import { describe, expect, it } from "vitest";
import { fastModelFor, RefusedModels, refusesModel } from "./small-models.ts";
import type { ModelCatalog } from "./contracts.ts";

const CHATGPT_REFUSAL = 'unexpected status 400 Bad Request: {"type":"invalid_request_error","message":"The \'gpt-5.4-mini\' model is not supported when using Codex with a ChatGPT account."}';

describe("refusesModel", () => {
  it("knows a refusal that names the model", () => {
    expect(refusesModel(CHATGPT_REFUSAL, "gpt-5.4-mini")).toBe(true);
    expect(refusesModel("There's an issue with the selected model (claude-haiku-4-5). It may not exist or you may not have access to it.", "claude-haiku-4-5")).toBe(true);
    expect(refusesModel("model_not_found: haiku-9 does not exist", "anthropic/haiku-9")).toBe(true);
  });

  it("leaves other failures, and refusals of another model, alone", () => {
    expect(refusesModel("stream disconnected before completion", "gpt-5.4-mini")).toBe(false);
    expect(refusesModel("400 Bad Request: input is too long", "gpt-5.4-mini")).toBe(false);
    expect(refusesModel(CHATGPT_REFUSAL, "gpt-6-luna")).toBe(false);
    expect(refusesModel(undefined, "gpt-5.4-mini")).toBe(false);
  });
});

const claude: ModelCatalog = {
  default: "claude-sonnet-5",
  options: [
    { id: "claude-opus-5", label: "Claude Opus 5" },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
  ],
};
const mixed: ModelCatalog = {
  default: "a",
  options: [
    { id: "gpt-5.4", label: "GPT 5.4", provider: "openai" },
    { id: "gemini-3.8-flash", label: "Gemini Flash", provider: "google" },
    { id: "gpt-5.4-mini", label: "GPT 5.4 Mini", provider: "openai" },
  ],
};

describe("fastModelFor", () => {
  it("finds the engine's quick variant", () => {
    expect(fastModelFor(claude, "claude-opus-5")).toBe("claude-haiku-4-5");
  });

  it("never crosses to another provider", () => {
    expect(fastModelFor(mixed, "gpt-5.4")).toBe("gpt-5.4-mini");
    expect(fastModelFor({ default: "x", options: [{ id: "x", label: "X", provider: "openai" }, { id: "y-flash", label: "Y", provider: "google" }] }, "x")).toBeUndefined();
  });

  it("skips a quick model the engine refused before", () => {
    expect(fastModelFor(mixed, "gpt-5.4", new Set(["gpt-5.4-mini"]))).toBeUndefined();
    expect(fastModelFor(claude, "claude-opus-5", new Set(["gpt-5.4-mini"]))).toBe("claude-haiku-4-5");
  });

  it("keeps a model that is already fast, and gives up without a catalog", () => {
    expect(fastModelFor(claude, "claude-haiku-4-5")).toBe("claude-haiku-4-5");
    expect(fastModelFor(undefined, "claude-opus-5")).toBeUndefined();
  });
});

it("keeps refused background models per connection across restarts", () => {
  const directory = mkdtempSync(join(tmpdir(), "omb-small-models-"));
  try {
    const file = join(directory, "refused-quick-models.json");
    new RefusedModels(file).remember("first", "gpt-5.4-mini");
    const restarted = new RefusedModels(file);
    expect(fastModelFor(mixed, "gpt-5.4", restarted.refused("first"))).toBeUndefined();
    expect(fastModelFor(mixed, "gpt-5.4", restarted.refused("second"))).toBe("gpt-5.4-mini");
  } finally {
    removeTempDir(directory);
  }
});
