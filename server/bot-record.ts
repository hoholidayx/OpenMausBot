import type { BotPromptOverrides } from "../shared/bot-prompts.ts";
import type { TeamSetupResult } from "../shared/team-setup.ts";
import type { WireBot } from "../shared/wire.ts";
import type { AgentPart, PartPair } from "./package-parts.ts";
import type { TaskRecord } from "./store.ts";

export interface BotRecord extends Omit<WireBot, "avatarUrl" | "tasks"> {
  workPartnerIds?: string[];
  promptOverrides?: BotPromptOverrides;
  modelPrefixOverrides?: Record<string, string>;
  tasks?: TaskRecord[];
  avatarUrl?: string;
  resumeCursors: Record<string, unknown>;
  mainThreadChoice?: string;
  /** Elevation journal: Full/Custom runs as Ask until Electron confirms the prepared reply; a marker surviving a restart is revoked on load. */
  approvalGrant?: {
    requestId: string;
    mode: "full" | "custom";
    phase: "prepared" | "confirmed" | "activated" | "committed";
    threadId?: string;
    threadOnly?: true;
    refreshPermissions?: true;
    allThreads?: true;
  };
  lastProfileRequestId?: string;
  lastTeamSetupReceipt?: { requestId: string; result: TeamSetupResult };
  packageBase?: Partial<Record<AgentPart, PartPair>>;
  assignedSkills?: string[];
}
