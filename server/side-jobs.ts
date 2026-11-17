import { randomUUID } from "node:crypto";

import { backgroundTextSlots, type JobSlots } from "./job-slots.ts";
import type { ProviderAdapter, ProviderInstance, SmallModelFallback, TextGenerationOptions } from "./contracts.ts";
import { refusesModel } from "./quick-model-fallback.ts";
import { fastModelFor } from "./turn-route.ts";
import type { UsageRow } from "./usage-ledger.ts";

/** "representative": a person's assistant answering a teammate's question for them, which must never get tools. */
export type SideJob = "skill-review" | "setup-suggestions" | "representative" | "status-reply";

export type SideJobInstance = Pick<ProviderInstance, "instanceId" | "driverKind" | "generateText" | "generateMemoryText" | "models" | "quickModelsUsable"> & {
  adapter: { capabilities: Pick<ProviderAdapter["capabilities"], "agentsMcp"> };
};

export interface SideJobBot {
  id: string;
  name: string;
  /** Where a spend alert a call raises is shown. */
  threadId: string;
  modelSelection: { instanceId: string; model?: string };
}

export interface SideJobText {
  generateText: (prompt: string, options?: SideJobTextOptions) => Promise<string>;
}

/** `waiting`: the call has to wait for a free slot (other bots' background calls); `started`: it starts now, after waiting
 * or at once. A call that is never queued calls neither. */
export type SideJobTextOptions = Pick<TextGenerationOptions, "signal" | "timeoutMs"> & { waiting?(): void; started?(): void };

export interface SideJobsDeps {
  bot: (botId: string) => SideJobBot | null | undefined;
  instance: (instanceId: string) => SideJobInstance | null | undefined;
  refusal: (instance: SideJobInstance) => string | undefined;
  /** Small models each engine instance refused, kept across restarts. */
  smallModels: { refused(instanceId: string): ReadonlySet<string>; remember(instanceId: string, model: string): void };
  /** Hosted workspaces only. */
  modelAllowed?: (selection: { instanceId: string; model: string }) => boolean;
  assertWithinBudget: () => void;
  book: (row: Omit<UsageRow, "at" | "costSource">, tokensReported: boolean, notificationThreadId: string) => void;
  log?: (line: string) => void;
  /** How many background jobs run at once, across bots. */
  slots?: JobSlots;
}

export interface SideJobs {
  text(job: SideJob, botId: string): SideJobText | null;
}

type TextCall = (prompt: string, options?: TextGenerationOptions) => Promise<string>;

/** A turn or a person is waiting on these, so they start at once. */
const NEVER_QUEUED: ReadonlySet<SideJob> = new Set(["representative", "status-reply"]);

export function createSideJobs(deps: SideJobsDeps): SideJobs {
  const ownFallback = (bot: SideJobBot, instance: SideJobInstance): SmallModelFallback => ({
    ...(bot.modelSelection.instanceId === instance.instanceId && bot.modelSelection.model ? { model: bot.modelSelection.model } : {}),
    refused: deps.smallModels.refused(instance.instanceId),
    onRefused: (model) => {
      deps.log?.(`small model ${model} refused on ${instance.instanceId}: background text runs on the bot's own model`);
      deps.smallModels.remember(instance.instanceId, model);
    },
  });

  /** The engine's fastest model by the quick-turn rule. Not for Claude: its one-off call already runs its own small model,
   * without thinking. */
  const quickModel = (bot: SideJobBot, own: SideJobInstance): { model?: string } => {
    if (own.driverKind === "claudeAgent" || own.quickModelsUsable?.() === false) return {};
    const current = bot.modelSelection.instanceId === own.instanceId && bot.modelSelection.model ? bot.modelSelection.model : own.models.default;
    const model = fastModelFor(own.models, current, deps.smallModels.refused(own.instanceId));
    return model && (!deps.modelAllowed || deps.modelAllowed({ instanceId: own.instanceId, model })) ? { model } : {};
  };

  /** A refused quick model is remembered, so the next card skips it; there is no time left to retry this one. */
  const rememberRefusal = (write: SideJobText["generateText"], own: SideJobInstance, model: string): SideJobText["generateText"] =>
    async (prompt, options) => {
      try {
        return await write(prompt, options);
      } catch (error) {
        if (refusesModel(error instanceof Error ? error.message : String(error), model)) deps.smallModels.remember(own.instanceId, model);
        throw error;
      }
    };

  const booked = (job: SideJob, bot: SideJobBot, instance: SideJobInstance, call: TextCall, fixed: () => TextGenerationOptions): SideJobText["generateText"] =>
    async (prompt, options) => {
      deps.assertWithinBudget();
      const threadId = `${job}-${randomUUID()}`;
      return call(prompt, {
        ...options,
        ...fixed(),
        onUsage: (usage) => deps.book({
          botId: bot.id,
          botName: bot.name,
          threadId,
          instanceId: instance.instanceId,
          driverKind: instance.driverKind,
          model: usage.model,
          input: usage.input ?? 0,
          output: usage.output ?? 0,
          ...(usage.cachedInput !== undefined ? { cachedInput: usage.cachedInput } : {}),
          costUsd: usage.costUsd ?? null,
          trigger: { kind: "bot", botId: bot.id },
        }, usage.input !== undefined && usage.output !== undefined, bot.threadId),
      });
    };

  const slots = deps.slots ?? backgroundTextSlots;
  const queued = (job: SideJob, found: SideJobText | null): SideJobText | null => found && !NEVER_QUEUED.has(job)
    ? { generateText: (prompt, { waiting, started, ...options } = {}) => slots.run(() => {
      started?.();
      return found.generateText(prompt, options);
    }, { signal: options.signal, interactive: job === "setup-suggestions", onWait: waiting }) }
    : found;

  function find(job: SideJob, botId: string): SideJobText | null {
    const bot = deps.bot(botId);
    const own = bot ? deps.instance(bot.modelSelection.instanceId) : null;
    if (!bot || !own || deps.refusal(own)) return null;
    if (job === "skill-review" && own.adapter.capabilities.agentsMcp !== true) return null;
    const call = own.generateText ?? (job === "skill-review" ? own.generateMemoryText : undefined);
    if (!call) return null;
    const generate = call.bind(own);
    if (job === "setup-suggestions") {
      const quick = quickModel(bot, own);
      const write = booked(job, bot, own, generate, () => ({ fallback: ownFallback(bot, own), ...quick }));
      return { generateText: quick.model ? rememberRefusal(write, own, quick.model) : write };
    }
    return { generateText: booked(job, bot, own, generate, () => ({ fallback: ownFallback(bot, own) })) };
  }
  return {
    text: (job, botId) => queued(job, find(job, botId)),
  };
}
