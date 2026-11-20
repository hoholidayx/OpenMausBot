import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { BOT_MEMORY_SERVER, BOT_MEMORY_TOOLS, type BotMemoryStatus, type MemoryConnectionStatus } from "../shared/bot-memory.ts";
import { allowsTool } from "../shared/tool-scope.ts";
import { writeFileAtomic } from "./atomic.ts";
import { McpHttpError, RemoteMcpClient } from "./mcp-http.ts";

export const BOT_MEMORY_PATH = "/api/internal/bot-memory/mcp";
const urlSchema = z.url({ protocol: /^https?$/ }).max(2048).refine(value => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return !url.username && !url.password && !url.search && !url.hash;
});
const tokenSchema = z.string().min(24).max(256).regex(/^[!-~]+$/);
const toolSchema = z.object({
  name: z.enum(BOT_MEMORY_TOOLS), description: z.string().max(8192).optional(),
  inputSchema: z.object({ type: z.literal("object"), properties: z.record(z.string(), z.unknown()).optional() }).passthrough(),
});
const accessSchema = z.object({ token: tokenSchema, tools: z.array(toolSchema).length(BOT_MEMORY_TOOLS.length) });
const preferenceSchema = z.object({ enabled: z.boolean(), revision: z.uuid(), legacyRole: accessSchema.optional() });
const settingsSchema = z.object({
  version: z.literal(2), environmentId: z.string(), url: urlSchema,
  connection: accessSchema.optional(), bots: z.record(z.uuid(), preferenceSchema),
});
const legacySchema = z.object({
  version: z.undefined().optional(), environmentId: z.string(), url: urlSchema,
  bots: z.record(z.uuid(), accessSchema.extend({ enabled: z.boolean(), revision: z.uuid() })),
}).transform(({ environmentId, url, bots }) => ({
  version: 2 as const, environmentId, url,
  bots: Object.fromEntries(Object.entries(bots).map(([id, { enabled, revision, ...legacyRole }]) => [id, { enabled, revision, legacyRole }])),
}));
type Tool = z.infer<typeof toolSchema>;
type Settings = z.infer<typeof settingsSchema>;
type Args = Record<string, unknown>;
type Partition = { userId: string; agentId: string };
export const memoryConnectionSchema = z.object({ url: urlSchema, token: tokenSchema }).strict();
export const memoryChangeSchema = z.object({ enabled: z.boolean() }).strict();
export type MemoryPermit = { device: string; revision: string };
const isRecord = (value: unknown): value is Args => value !== null && typeof value === "object" && !Array.isArray(value);
const rejected = (text: string) => ({ isError: true, content: [{ type: "text", text }] });

export class MemoryRefusal extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

async function withClient<T>(url: string, token: string, partition: Partition | undefined, signal: AbortSignal, work: (client: RemoteMcpClient) => Promise<T>): Promise<T> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (partition) {
    headers["X-Mem0-User-Id"] = partition.userId;
    headers["X-Mem0-Agent-Id"] = partition.agentId;
  }
  const client = new RemoteMcpClient({ type: "http", url, headers }, {
    maxBytes: 2_000_000, fetch: (input, init) => fetch(input, { ...init, redirect: "error" }),
  });
  try {
    const hello = await client.initialize("openmausbot-memory", signal);
    if (!isRecord(hello) || !isRecord(hello.serverInfo) || hello.serverInfo.name !== "mem0-mcp-lan") throw new Error("Unexpected memory service.");
    return await work(client);
  } finally { await client.close(); }
}

function containsCredential(value: unknown, token: string): boolean {
  return JSON.stringify(value)?.includes(JSON.stringify(token).slice(1, -1)) === true;
}

function rpcCall(client: RemoteMcpClient, name: string, args: Args, signal: AbortSignal) {
  return client.request("tools/call", { name, arguments: args }, signal);
}

async function checkPartition(client: RemoteMcpClient, userId: string, agentId: string, signal: AbortSignal) {
  const result = await rpcCall(client, "memory_list", { userId, agentId, scope: "long-term", limit: 1 }, signal);
  if (!isRecord(result) || result.isError || !isRecord(result.structuredContent) || !Array.isArray(result.structuredContent.memories)) {
    throw new MemoryRefusal(422, "The credential could not read this bot's memory partition.");
  }
}

function publicTool(tool: Tool): Tool {
  const properties = { ...tool.inputSchema.properties };
  for (const key of ["userId", "agentId", "longTerm", "scope", "all", "confirm"]) delete properties[key];
  return { ...tool, ...(tool.name === "memory_delete" ? { description: "Preview matching memories with a query, or request deletion of one exact memory ID." } : {}), inputSchema: { ...tool.inputSchema, properties } };
}

export async function verifyMemoryRole(url: string, token: string, userId: string, agentId: string, signal: AbortSignal) {
  return withClient(url, token, undefined, signal, client => verifyRole(client, userId, agentId, signal));
}

function refusalCode(result: unknown): string | undefined {
  if (!isRecord(result) || result.isError !== true || !Array.isArray(result.content)) return;
  const text = result.content[0]?.text;
  if (typeof text !== "string") return;
  try { return JSON.parse(text)?.code; } catch { return; }
}

async function requireLongTermRole(client: RemoteMcpClient, userId: string, agentId: string, signal: AbortSignal) {
  const session = await rpcCall(client, "memory_list", { userId, agentId, scope: "session", limit: 1 }, signal);
  if (refusalCode(session) !== "session_unavailable") throw new MemoryRefusal(422, "Use a long-term role with no bound session.");
}

async function verifyRole(client: RemoteMcpClient, userId: string, agentId: string, signal: AbortSignal) {
  await checkPartition(client, userId, agentId, signal);
  const other = await rpcCall(client, "memory_list", { userId, agentId: randomUUID(), scope: "long-term", limit: 1 }, signal);
  if (refusalCode(other) !== "scope_denied") throw new MemoryRefusal(422, "Mem0 did not enforce the requested bot partition.");
  await requireLongTermRole(client, userId, agentId, signal);
}

async function verifyConnection(url: string, token: string, userId: string, signal: AbortSignal) {
  const botId = randomUUID();
  return withClient(url, token, { userId, agentId: botId }, signal, async client => {
    await verifyRole(client, userId, botId, signal);
    const list = await client.request("tools/list", {}, signal);
    const tools = z.array(toolSchema).safeParse(isRecord(list) ? list.tools : null);
    if (!tools.success || containsCredential(tools.data, token) || tools.data.length !== BOT_MEMORY_TOOLS.length || new Set(tools.data.map(tool => tool.name)).size !== BOT_MEMORY_TOOLS.length) {
      throw new MemoryRefusal(422, "The memory service did not offer the six expected tools.");
    }
    return tools.data.map(publicTool);
  });
}

export interface BotMemoryDeps {
  dataDir: string;
  environmentId: string;
  /** Revoke active calls and confirmations when the saved binding changes. */
  changed(): void;
  sharesEndpoint(url: string): boolean;
}

export class BotMemory {
  private readonly file: string;
  private settings?: Settings;
  private unreadable = false;
  private readonly failed = new Set<string>();
  private readonly deps: BotMemoryDeps;

  constructor(deps: BotMemoryDeps) {
    this.deps = deps;
    this.file = join(deps.dataDir, "providers", "mem0", deps.environmentId, "bindings.json");
    try {
      const saved = z.union([settingsSchema, legacySchema]).parse(JSON.parse(readFileSync(this.file, "utf8")));
      if (saved.environmentId === deps.environmentId) this.settings = saved;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.unreadable = true;
    }
  }

  connectionStatus(): MemoryConnectionStatus {
    return { configured: Boolean(this.settings?.connection), url: this.settings?.url };
  }

  private accessFor(botId: string) {
    const settings = this.settings;
    if (!settings) return;
    const access = settings.connection ?? settings.bots[botId]?.legacyRole;
    if (!access) return;
    const partition = settings.connection ? { userId: this.userId, agentId: botId } : undefined;
    return { ...access, url: settings.url, partition };
  }

  status(botId: string): BotMemoryStatus {
    const preference = this.settings?.bots[botId];
    return { configured: Boolean(this.accessFor(botId)), enabled: preference?.enabled === true,
      failed: this.unreadable || this.failed.has(botId), url: this.settings?.url, userId: this.userId, agentId: botId };
  }

  private get userId() { return `maus-${this.deps.environmentId}`; }

  private save(settings: Settings) {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.file, JSON.stringify(settings), { mode: 0o600 });
    this.settings = settings;
  }

  forget(botId: string) {
    this.failed.delete(botId);
    if (!this.settings?.bots[botId]) return;
    const bots = { ...this.settings.bots };
    delete bots[botId];
    this.save({ ...this.settings, bots });
    this.deps.changed();
  }

  private checkSettings() {
    if (this.unreadable) throw new MemoryRefusal(409, "The saved memory settings could not be read.");
  }

  private checkEndpoint(url: string) {
    if (this.deps.sharesEndpoint(url)) throw new MemoryRefusal(409, "Disable the shared MCP connection to this memory address first.");
  }

  async connect(input: z.infer<typeof memoryConnectionSchema>, active: () => boolean, firstOnly: boolean) {
    this.checkSettings();
    const previous = this.settings?.connection;
    if (firstOnly && previous) return this.connectionStatus();
    const url = new URL(input.url).href;
    this.checkEndpoint(url);
    let tools: Tool[];
    try {
      tools = await verifyConnection(url, input.token, this.userId, AbortSignal.timeout(10_000));
    } catch (error) {
      if (error instanceof MemoryRefusal) throw error;
      if (error instanceof McpHttpError && [400, 401, 403].includes(error.status ?? 0)) {
        throw new MemoryRefusal(422, "Mem0 requires its service credential for bot partitions.");
      }
      throw new MemoryRefusal(502, "Could not verify the Maus connection to Mem0.");
    }
    if (!active()) throw new MemoryRefusal(403, "The owner session is no longer available.");
    if (this.settings?.connection !== previous) {
      if (firstOnly) return this.connectionStatus();
      throw new MemoryRefusal(409, "The memory connection changed. Try again.");
    }
    this.checkEndpoint(url);
    const replaced = previous?.token !== input.token || this.settings?.url !== url;
    const bots = Object.fromEntries(Object.entries(this.settings?.bots ?? {}).map(([id, { enabled, revision }]) =>
      [id, { enabled, revision: replaced ? randomUUID() : revision }]));
    this.save({ version: 2, environmentId: this.deps.environmentId, url, connection: { token: input.token, tools }, bots });
    this.failed.clear();
    if (replaced) this.deps.changed();
    return this.connectionStatus();
  }

  change(botId: string, enabled: boolean) {
    this.checkSettings();
    const settings = this.settings;
    const preference = settings?.bots[botId];
    if (enabled) {
      if (!settings || !(settings.connection || preference?.legacyRole)) throw new MemoryRefusal(409, "Connect Maus to Mem0 first.");
      this.checkEndpoint(settings.url);
    }
    if (settings && enabled !== (preference?.enabled === true)) {
      this.save({ ...settings, bots: { ...settings.bots, [botId]: { ...preference, enabled, revision: randomUUID() } } });
      this.deps.changed();
    }
    this.failed.delete(botId);
    return this.status(botId);
  }

  mayRestoreShared(): boolean {
    return !this.unreadable && !Object.values(this.settings?.bots ?? {}).some(binding => binding.enabled);
  }

  usesEndpoint(url: string): boolean {
    return this.settings?.url === url && !this.mayRestoreShared();
  }

  revision(botId: string): string | undefined {
    const binding = this.settings?.bots[botId];
    return binding?.enabled && this.settings && !this.deps.sharesEndpoint(this.settings.url) ? binding.revision : undefined;
  }

  async rpc(input: { botId: string; revision: string; frame: unknown; scope(): unknown; active(): boolean; signal: AbortSignal;
    confirm(id: string, signal: AbortSignal): Promise<boolean> }): Promise<unknown> {
    const { frame, botId, revision, signal } = input;
    const access = this.accessFor(botId);
    const active = () => !signal.aborted && input.active() && this.revision(botId) === revision;
    if (!access || !active()) throw new MemoryRefusal(403, "This memory connection is closed.");
    if (!isRecord(frame) || frame.jsonrpc !== "2.0" || typeof frame.method !== "string") throw new MemoryRefusal(400, "Invalid MCP request.");
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id: frame.id, result });
    if (!Object.hasOwn(frame, "id")) return undefined;
    const params = isRecord(frame.params) ? frame.params : {};
    if (frame.method === "initialize") return reply({ protocolVersion: params.protocolVersion ?? "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: BOT_MEMORY_SERVER, version: "1" } });
    if (frame.method === "ping") return reply({});
    const allowed = (name: string) => allowsTool(input.scope(), { kind: "mcp", server: BOT_MEMORY_SERVER, name });
    if (frame.method === "tools/list") return reply({ tools: access.tools.filter(tool => allowed(tool.name)) });
    if (frame.method !== "tools/call") return { jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: "Method not found." } };
    const name = params.name;
    const args = params.arguments ?? {};
    if (typeof name !== "string" || !access.tools.some(tool => tool.name === name) || !allowed(name) || !isRecord(args)) {
      return reply(rejected("This memory tool is unavailable."));
    }
    if (["userId", "agentId", "scope", "longTerm", "all", "confirm"].some(key => Object.hasOwn(args, key))) return reply(rejected("Use the memory partition assigned to this bot."));
    const identity = { userId: this.userId, agentId: botId };
    if (name === "memory_delete" && Object.hasOwn(args, "memoryId")) {
      const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).safeParse(args.memoryId);
      if (!id.success || Object.keys(args).length !== 1) return reply(rejected("Delete one memory by its exact ID."));
      if (!await input.confirm(id.data, signal)) return reply(rejected("Deletion was not approved."));
    }
    const permitted = () => active() && allowed(name);
    if (!permitted()) return reply(rejected("This memory call is no longer authorized."));
    try {
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
      const result = await withClient(access.url, access.token, access.partition, requestSignal, async client => {
        const idOnly = name === "memory_get" || name === "memory_update";
        if (!access.partition && (idOnly || (name === "memory_delete" && "memoryId" in args))) await requireLongTermRole(client, identity.userId, botId, requestSignal);
        if (!permitted()) return rejected("This memory call is no longer authorized.");
        const scoped = idOnly ? args : { ...args, ...identity,
          ...(name === "memory_search" || name === "memory_list" || (name === "memory_delete" && "query" in args) ? { scope: "long-term" } : {}) };
        return rpcCall(client, name, scoped, requestSignal);
      });
      if (!permitted()) return reply(rejected("This memory call is no longer authorized."));
      if (containsCredential(result, access.token)) return reply(rejected("Mem0 returned private credential data."));
      const code = refusalCode(result);
      if (code === "scope_denied" || code?.startsWith("upstream_")) this.failed.add(botId);
      else this.failed.delete(botId);
      return reply(result);
    } catch {
      if (permitted()) this.failed.add(botId);
      return reply(rejected("Could not reach this bot's memories. Check the result before repeating a write."));
    }
  }
}
