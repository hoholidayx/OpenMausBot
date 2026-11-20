export interface OpenAIUsage {
  input: number;
  output: number;
  cachedInput?: number;
}

export interface OpenAIChatTokenUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  cost?: number;
}

export function usageCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function reportedChatUsage(requested: string, served: string | undefined, usage: OpenAIChatTokenUsage | undefined) {
  return {
    model: typeof served === "string" && served.trim() ? served : requested,
    input: usageCount(usage?.prompt_tokens),
    output: usageCount(usage?.completion_tokens),
    cachedInput: usageCount(usage?.prompt_tokens_details?.cached_tokens),
    costUsd: usageCount(usage?.cost),
  };
}

export function chatUsageFrom(usage: OpenAIChatTokenUsage | undefined): OpenAIUsage | null {
  if (!usage) return null;
  const cachedInput = usageCount(usage.prompt_tokens_details?.cached_tokens);
  return {
    input: usage.prompt_tokens ?? 0,
    output: usage.completion_tokens ?? 0,
    ...(cachedInput === undefined ? {} : { cachedInput }),
  };
}

export function addUsage(total: OpenAIUsage, round: OpenAIUsage): void {
  total.input += round.input;
  total.output += round.output;
  if (round.cachedInput !== undefined) total.cachedInput = (total.cachedInput ?? 0) + round.cachedInput;
}
