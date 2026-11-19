import { readFileSync } from "node:fs";
import { z } from "zod";
import { BOT_PROFILE_LIMITS } from "../shared/bot-profile.ts";
import type { BotModelPrefixSetting } from "../shared/bot-prompts.ts";
import type { BotRecord } from "./bot-record.ts";
import { writeFileAtomic } from "./atomic.ts";
import type { ProviderInstance } from "./contracts.ts";
import { replaysTranscriptNatively } from "./runtime/capabilities.ts";
import type { buildSystemPrompt } from "./system-prompt.ts";

export const MODEL_SYSTEM_PREFIX_MAX_BYTES = BOT_PROFILE_LIMITS.soul;
export const supportsModelSystemPrefix = replaysTranscriptNatively;

type Prompt = ReturnType<typeof buildSystemPrompt>;
type Connection = Pick<ProviderInstance, "instanceId" | "driverKind">;
const storedPrefixes = z.record(z.string(), z.string());
export const modelPrefixKey = (instanceId: string, model: string) => JSON.stringify([instanceId, model]);

export function createModelSystemPrefixes(file: string) {
  let values = new Map<string, string>();
  let loadFailed = false;
  try {
    values = new Map(Object.entries(storedPrefixes.parse(JSON.parse(readFileSync(file, "utf8")))));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      loadFailed = true;
      console.warn("Model system prefixes could not be loaded.");
    }
  }

  const get = (instanceId: string, model: string) => values.get(modelPrefixKey(instanceId, model)) ?? "";

  return {
    read(instanceId: string, model: string) {
      if (loadFailed) throw new Error("Model system prefixes could not be loaded.");
      return get(instanceId, model);
    },
    setting(bot: Pick<BotRecord, "modelSelection" | "modelPrefixOverrides">, connection: Connection | null): BotModelPrefixSetting | null {
      const { instanceId, model } = bot.modelSelection;
      if (!connection || !model || !supportsModelSystemPrefix(connection.driverKind)) return null;
      return {
        id: "model-system-prefix", instanceId, model,
        defaultText: get(instanceId, model),
        override: bot.modelPrefixOverrides?.[modelPrefixKey(instanceId, model)] ?? null,
      };
    },
    save(instanceId: string, model: string, text: string) {
      if (loadFailed) throw new Error("Model system prefixes could not be loaded.");
      const value = text.trim() ? text : "";
      if (Buffer.byteLength(value) > MODEL_SYSTEM_PREFIX_MAX_BYTES) {
        throw Object.assign(new Error("Model system prefix exceeds 24,000 UTF-8 bytes."), { status: 400 });
      }
      if (value === get(instanceId, model)) return value;
      const next = new Map(values);
      if (value) next.set(modelPrefixKey(instanceId, model), value);
      else next.delete(modelPrefixKey(instanceId, model));
      writeFileAtomic(file, JSON.stringify(Object.fromEntries(next)), { mode: 0o600 });
      values = next;
      return value;
    },
    apply(prompt: Prompt, connection: Connection | null, model: string, overrides?: BotRecord["modelPrefixOverrides"]): Prompt {
      if (!connection || !supportsModelSystemPrefix(connection.driverKind)) return prompt;
      const prefix = overrides?.[modelPrefixKey(connection.instanceId, model)] ?? get(connection.instanceId, model);
      if (!prefix) return prompt;
      const text = prefix + "\n\n";
      const section = { id: "model-system-prefix", label: "Model system prefix", text, bytes: Buffer.byteLength(text) };
      return {
        ...prompt,
        sections: [section, ...prompt.sections],
        text: text + prompt.text,
        stable: text + prompt.stable,
      };
    },
  };
}
