import { autoRecallEnabled, roomMemoryCaptureEnabled, type AppConfig } from "./config.ts";
import type { Message } from "./store.ts";

export const legacyMemoryEnabled = process.env.OMB_LEGACY_MEMORY === "1";
export const LEGACY_MEMORY_DISABLED = "Legacy memory is disabled on this server.";
export const MEMORY_OFF_CONTEXT_VERSION = 2;

export function isLegacyMemoryCard(card: Message["card"]): boolean {
  return Boolean(card?.teamMemoryRequest || card?.outsideWrite?.kind === "memory");
}

export function isLegacyMemoryTool(name: string): boolean {
  return /^(?:(?:mcp__)?agents(?:__|[.:/]))?(?:memory_update|memory_log|propose_team_memory)$/.test(name);
}

export function legacyBotMemoryEnabled(bot: { memoryEnabled?: boolean }): boolean {
  return legacyMemoryEnabled && bot.memoryEnabled !== false;
}

export function legacyMemoryFeatures(config: AppConfig) {
  return {
    legacyMemory: legacyMemoryEnabled,
    autoRecall: legacyMemoryEnabled && autoRecallEnabled(config),
    roomMemoryCapture: legacyMemoryEnabled && roomMemoryCaptureEnabled(config),
  };
}

const LEGACY_AGENT_ROUTES = new Set([
  "/api/internal/memory",
  "/api/internal/memory/log",
  "/api/internal/team-memory",
]);

export function legacyMemoryCallDisabled(path: string): boolean {
  return !legacyMemoryEnabled && LEGACY_AGENT_ROUTES.has(path);
}
