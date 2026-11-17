import type { Message } from "./store.ts";

export const LEGACY_MEMORY_DISABLED = "Legacy memory is disabled on this server.";
export const MEMORY_OFF_CONTEXT_VERSION = 3;

export function isLegacyMemoryCard(card: Message["card"]): boolean {
  return Boolean(card?.teamMemoryRequest || card?.outsideWrite?.kind === "memory");
}

export function isLegacyMemoryTool(name: string): boolean {
  return /^(?:(?:mcp__)?agents(?:__|[.:/]))?(?:memory_update|memory_log|propose_team_memory)$/.test(name);
}
