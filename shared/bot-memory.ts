export const BOT_MEMORY_SERVER = "maus_memory";
export const BOT_MEMORY_TOOLS = ["memory_search", "memory_list", "memory_get", "memory_add", "memory_update", "memory_delete"] as const;

export const MEMORY_CONNECTION_PATH = "/api/bot-memory/connection";

export interface MemoryConnectionStatus {
  configured: boolean;
  url?: string;
}

export interface BotMemoryStatus extends MemoryConnectionStatus {
  enabled: boolean;
  failed: boolean;
  userId: string;
  agentId: string;
}
