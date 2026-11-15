import { autoRecallEnabled, roomMemoryCaptureEnabled, type AppConfig } from "./config.ts";

export const legacyMemoryEnabled = process.env.OMB_LEGACY_MEMORY === "1";
export const LEGACY_MEMORY_DISABLED = "Legacy memory is disabled on this server.";

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
  "/api/internal/session-search",
  "/api/internal/session-read",
]);

export function legacyMemoryCallDisabled(path: string): boolean {
  return !legacyMemoryEnabled && LEGACY_AGENT_ROUTES.has(path);
}
