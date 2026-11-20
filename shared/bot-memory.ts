export const BOT_MEMORY_SERVER = "maus_memory";
export const BOT_MEMORY_TOOLS = ["memory_search", "memory_list", "memory_get", "memory_add", "memory_update", "memory_delete"] as const;

export interface BotMemoryStatus {
  configured: boolean;
  enabled: boolean;
  failed: boolean;
  url?: string;
  userId: string;
  agentId: string;
}
