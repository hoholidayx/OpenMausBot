import type { BotToolBlock, BotToolCatalog, BotToolEntry, BotToolSource } from "../../shared/bot-tool-catalog.ts";
import { connectorAccessDecision } from "../../shared/connector-scopes.ts";
import { EMAIL_MCP_SERVER } from "../../shared/email.ts";
import { OWN_APPS_SERVER } from "../../shared/own-apps.ts";
import { PHONE_MCP_SERVER } from "../../shared/phone-apps.ts";
import type { ToolGroup } from "../../shared/tool-groups.ts";
import { evaluateConnectorTools } from "../connector-verdict.ts";
import type { ProviderAdapter } from "../contracts.ts";
import { DATA_TOOLS } from "../data/tools.ts";
import { availableTools, type CatalogProfile } from "../drivers/agents-catalog.ts";
import { TOOL_GROUP_MEMBERS } from "../drivers/agents-tool-groups.ts";
import { emailAccess } from "../email/host.ts";
import { EMAIL_TOOLS } from "../email/tools.ts";
import type { McpConfig } from "../host/mcp-config.ts";
import type { McpProbeResult } from "../mcp-probe.ts";
import { mcpServerServes } from "../mcp-registry.ts";
import { personKey } from "../person-key.ts";
import type { BotRecord } from "../store.ts";
import { userError } from "../user-errors.ts";
import { PASS, type RouteHandler } from "./table.ts";
import { sessionMember } from "./team-phone.ts";

const PATH = /^\/api\/bots\/([\w-]+)\/tool-catalog(?:\/(apps|mcp\/([a-z][a-z0-9_-]{0,31})))?$/;
const GROUP_BY_TOOL = new Map(Object.entries(TOOL_GROUP_MEMBERS).flatMap(([group, members]) =>
  [...members.tools].map((name) => [name, group as ToolGroup] as const)));

interface CatalogServer {
  name: string;
  enabled: boolean;
  bot?: string;
  runsOn?: unknown;
  managedBy?: string;
  auth?: string;
  offFor?: readonly string[];
  keyOff?: boolean;
}

type Capabilities = ProviderAdapter["capabilities"];
type NamedTool = { name: string };
interface CatalogFacts {
  caps: Capabilities | undefined;
  profile: CatalogProfile;
  dataReady: boolean;
  emailReady: boolean;
  browser: { blocked?: BotToolBlock; tools?: readonly NamedTool[] };
  phoneTools?: readonly NamedTool[];
  apps: boolean;
}

export interface BotToolCatalogDeps {
  bot(id: string): BotRecord | null;
  facts(bot: BotRecord): CatalogFacts;
  servers(): readonly CatalogServer[];
  apps(): Promise<{ tools: Record<string, readonly NamedTool[]>; connected: ReadonlySet<string> }>;
  appBlock(slug: string): BotToolBlock | "turn-dependent" | undefined;
  test: McpConfig["test"];
  probeAs(bot: BotRecord): { id: string; cwd: string };
  ownConnection(person: string, name: string, url: string): ReturnType<NonNullable<Parameters<McpConfig["test"]>[1]["person"]>>;
}

function entries(server: string, tools: readonly NamedTool[], block?: (name: string) => BotToolBlock | undefined): BotToolEntry[] {
  return [...new Set(tools.map(({ name }) => name))].map((name) => {
    const blocked = block?.(name);
    return { tool: { kind: "mcp", server, name }, ...(blocked ? { blocked } : {}) };
  });
}

function mcpSource(server: CatalogServer, bot: BotRecord, caps: Capabilities | undefined): BotToolSource {
  const blocked = !server.enabled ? "disabled" : server.managedBy ? "policy" : !caps?.customMcp ? "engine"
    : bot.mcpServers && !bot.mcpServers.includes(server.name) ? "not-mounted" : undefined;
  const notice = server.auth === "needs-sign-in" ? "sign-in" : server.keyOff || server.offFor?.includes(bot.id)
    ? "connection-failed" : server.runsOn ? "turn-dependent" : "unlisted";
  return {
    id: `mcp:${server.name}`, name: server.name, kind: "mcp", tools: [], blocked, notice,
    ...(server.enabled && !server.runsOn && !server.managedBy ? { discover: true } : {}),
  };
}

function agentsSources(profile: CatalogProfile, supported: boolean): BotToolSource[] {
  const baseProfile = { ...profile, toolsOff: undefined };
  const activeNames = new Set(availableTools(baseProfile).map(({ name }) => name));
  const candidates = availableTools({
    ...baseProfile, skillAuthoring: true, sharedComputers: true, voiceNotes: true, xResearch: true,
    research: true, imageGeneration: true,
    meetings: true, appHosting: true, computerSelection: true, cloudHome: false,
  });
  const agents = new Map<string, BotToolSource>([["agents", { id: "agents", kind: "agents", tools: [] }]]);
  for (const entry of entries("agents", candidates, (name) => !supported ? "engine" : !activeNames.has(name) ? "environment" : undefined)) {
    const group = GROUP_BY_TOOL.get(entry.tool.name);
    const id = group ?? "agents";
    const source = agents.get(id) ?? { id, kind: "group", group, tools: [] };
    source.tools.push(entry);
    agents.set(id, source);
  }
  return [...agents.values()];
}

function phoneSource(caps: Capabilities | undefined, tools: readonly NamedTool[] = []): BotToolSource {
  return { id: "phone", kind: "phone", blocked: caps?.deviceMcp ? undefined : "engine", notice: "person-dependent",
    tools: entries(PHONE_MCP_SERVER, tools) };
}

function builtInToolSources(bot: BotRecord, { caps, profile, dataReady, emailReady, browser, phoneTools }: CatalogFacts): BotToolSource[] {
  return [
    { id: "native", kind: "native", notice: "engine-catalog", tools: caps?.askTool?.kind === "native" ? [{ tool: caps.askTool }] : [] },
    ...agentsSources(profile, caps?.agentsMcp === true),
    { id: "data", kind: "group", group: "data", blocked: !caps?.dataMcp ? "engine" : !dataReady ? "environment" : undefined,
      tools: entries("data", DATA_TOOLS) },
    { id: "email", kind: "group", group: "email", blocked: !caps?.emailMcp ? "engine" : !emailReady ? "not-connected" : undefined,
      tools: entries(EMAIL_MCP_SERVER, EMAIL_TOOLS, (name) => emailAccess(bot, name).ok ? undefined : "unauthorized") },
    { id: "browser", kind: "browser", blocked: browser.blocked, notice: browser.tools ? undefined : "engine-catalog",
      tools: entries("browser", browser.tools ?? []) },
    { id: "computer", kind: "computer", blocked: !caps?.computerMcp && !caps?.localComputerMcp ? "engine" : bot.computer === "off" ? "disabled" : undefined,
      notice: "turn-dependent", tools: [] },
    phoneSource(caps, phoneTools),
  ];
}

function appSources(bot: BotRecord, facts: CatalogFacts, catalog: Awaited<ReturnType<BotToolCatalogDeps["apps"]>>, appBlock: BotToolCatalogDeps["appBlock"]): BotToolSource[] {
  return Object.entries(catalog.tools).map(([slug, tools]) => {
    const restriction = appBlock(slug);
    const personal = restriction === "turn-dependent";
    const blocked = !facts.caps?.composioMcp ? "engine" : bot.composio === false ? "disabled"
      : personal ? undefined : restriction ?? (!catalog.connected.has(slug) ? "not-connected" : undefined);
    return {
      id: `app:${slug}`, kind: "app", name: slug, blocked,
      ...(personal ? { notice: "person-dependent" } : {}),
      tools: entries(personal ? OWN_APPS_SERVER : "composio", tools, (name) =>
        evaluateConnectorTools([name], bot.connectorTools, [slug]).allowed &&
          connectorAccessDecision(bot.connectorScopes, [{ slug: name }], [slug]).ok ? undefined : "unauthorized"),
    };
  });
}

export function createBotToolCatalogRoutes(deps: BotToolCatalogDeps): RouteHandler {
  return async ({ method, path, auth, res, json }) => {
    const match = PATH.exec(path);
    if (!match || method !== (match[3] ? "POST" : "GET")) return PASS;
    res.setHeader("Cache-Control", "no-store");
    const bot = deps.bot(match[1]!);
    if (!bot) return json(res, 404, userError("serverError.bot.missing"));
    const facts = deps.facts(bot);
    if (match[2] === "apps") {
      try {
        const sources = facts.apps ? appSources(bot, facts, await deps.apps(), deps.appBlock) : [];
        return json(res, 200, { sources });
      } catch {
        return json(res, 502, { error: "Couldn't load app tools." });
      }
    }
    const servers = deps.servers().filter((server) => mcpServerServes(server, bot.id));
    if (!match[3]) {
      const catalog: BotToolCatalog = {
        sources: [...builtInToolSources(bot, facts), ...servers.map((server) => mcpSource(server, bot, facts.caps))],
        apps: facts.apps,
      };
      return json(res, 200, catalog);
    }
    const server = servers.find(({ name }) => name === match[3]);
    if (!server) return json(res, 404, { error: "No such MCP server for this bot." });
    if (!mcpSource(server, bot, facts.caps).discover) return json(res, 409, { error: "This server cannot be listed here." });
    const controller = new AbortController();
    const disconnect = () => { if (!res.writableEnded) controller.abort(); };
    res.once("close", disconnect);
    try {
      const result = await deps.test(server.name, {
        signal: controller.signal, catalogOnly: true, asBot: deps.probeAs(bot),
        person: (url) => {
          const session = auth.kind === "session" ? sessionMember(auth.session) : null;
          return session ? deps.ownConnection(personKey({ id: "", email: session.member.email }), server.name, url) : null;
        },
      });
      const probe = "body" in result ? result.body as McpProbeResult : null;
      if (!probe?.ok) return json(res, 200, { notice: probe?.auth === "required" ? "sign-in" : "connection-failed" });
      return json(res, 200, { tools: entries(server.name, probe.tools), ...(probe.partial ? { notice: "partial" } : {}) });
    } finally {
      res.off("close", disconnect);
    }
  };
}
