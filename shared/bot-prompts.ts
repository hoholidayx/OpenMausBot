export const BOT_PROMPT_FIELDS = ["soul", "persona", "reply-style", "reply-habits", "room-style"] as const;
export type BotPromptField = typeof BOT_PROMPT_FIELDS[number];
export type BotPromptOverrides = Partial<Record<Exclude<BotPromptField, "soul">, string>>;

export interface BotPromptSetting {
  id: BotPromptField;
  defaultText: string;
  /** Null follows the built-in default. An empty override suppresses that section. */
  override: string | null;
}
