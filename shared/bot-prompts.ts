export const BOT_PROMPT_FIELDS = ["soul", "persona", "reply-style", "reply-habits", "room-style"] as const;
export type BotPromptField = typeof BOT_PROMPT_FIELDS[number];
export type BotPromptOverrides = Partial<Record<Exclude<BotPromptField, "soul">, string>>;

export interface BotPromptSetting {
  id: BotPromptField;
  defaultText: string;
  /** Null follows the built-in default. An empty override suppresses that section. */
  override: string | null;
}

export interface BotModelPrefixSetting {
  id: "model-system-prefix";
  instanceId: string;
  model: string;
  defaultText: string;
  /** Null follows this connection and model. An empty string disables injection for this bot. */
  override: string | null;
}
