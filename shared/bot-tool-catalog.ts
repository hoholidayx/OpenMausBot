import type { ToolGroup } from "./tool-groups.ts";
import type { ToolIdentity } from "./tool-scope.ts";

export type BotToolBlock = "engine" | "environment" | "disabled" | "not-mounted" | "not-connected" | "unauthorized" | "policy";
export type BotToolNotice = "engine-catalog" | "turn-dependent" | "person-dependent" | "sign-in" | "connection-failed" | "unlisted" | "partial";

export interface BotToolEntry {
  tool: ToolIdentity;
  blocked?: BotToolBlock;
}

export interface BotToolSource {
  id: string;
  kind: "native" | "agents" | "group" | "browser" | "computer" | "phone" | "app" | "mcp";
  group?: ToolGroup;
  name?: string;
  blocked?: BotToolBlock;
  notice?: BotToolNotice;
  discover?: true;
  tools: BotToolEntry[];
}

export interface BotToolCatalog {
  sources: BotToolSource[];
  apps: boolean;
}
