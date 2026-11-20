import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { BOT_MEMORY_SERVER, BOT_MEMORY_TOOLS, type BotMemoryStatus } from "../shared/bot-memory.ts";
import { allowsTool } from "../shared/tool-scope.ts";
import { writeFileAtomic } from "./atomic.ts";
import { RemoteMcpClient } from "./mcp-http.ts";

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
const bindingSchema = z.object({ token: tokenSchema, enabled: z.boolean(), revision: z.uuid(), tools: z.array(toolSchema).length(BOT_MEMORY_TOOLS.length) });
const settingsSchema = z.object({ environmentId: z.string(), url: urlSchema, bots: z.record(z.uuid(), bindingSchema) });
type Tool = z.infer<typeof toolSchema>;
type Settings = z.infer<typeof settingsSchema>;
type Args = Record<string, unknown>;
export type MemoryChange = { enabled: boolean; token?: string; url?: string };
export const memoryChangeSchema = z.object({ enabled: z.boolean(), token: tokenSchema.optional(), url: urlSchema.optional() }).strict()
  .refine(input => input.enabled || (!input.token && !input.url));
export type MemoryPermit = { device: string; revision: string };
const isRecord = (value: unknown): value is Args => value !== null && typeof value === "object" && !Array.isArray(value);
const rejected = (text: string) => ({ isError: true, content: [{ type: "text", text }] });

export class MemoryRefusal extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

async function withClient<T>(url: string, token: string, signal: AbortSignal, work: (client: RemoteMcpClient) => Promise<T>): Promise<T> {
  const client = new RemoteMcpClient({ type: "http", url, headers: { Authorization: `Bearer ${token}` } }, {
    maxBytes: 2_000_000, fetch: (input, init) => fetch(input, { ...init, redirect: "error" }),
  });
  try {
    const hello = await client.initialize("openmausbot-memory", signal);
    if (!isRecord(hello) || !isRecord(hello.serverInfo) || hello.serverInfo.name !== "mem0-mcp-lan") throw new Error("Unexpected memory service.");
    return await work(client);
  } finally { await client.close(); }
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
  return withClient(url, token, signal, client => verifyRole(client, userId, agentId, signal));
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
  if (refusalCode(other) !== "scope_denied") throw new MemoryRefusal(422, "The credential must be restricted to one bot.");
  await requireLongTermRole(client, userId, agentId, signal);
}

async function verifyBinding(url: string, token: string, userId: string, botId: string, signal: AbortSignal) {
  return withClient(url, token, signal, async client => {
    await verifyRole(client, userId, botId, signal);
    const list = await client.request("tools/list", {}, signal);
    const tools = z.array(toolSchema).safeParse(isRecord(list) ? list.tools : null);
    if (!tools.success || tools.data.length !== BOT_MEMORY_TOOLS.length || new Set(tools.data.map(tool => tool.name)).size !== BOT_MEMORY_TOOLS.length) {
      throw new MemoryRefusal(422, "The memory service did not offer the six expected tools.");
    }
    return tools.data.map(publicTool);
  });
}

export interface BotMemoryDeps {
  dataDir: string;
  environmentId: string;
  botExists(id: string): boolean;
  /** Revoke active calls and confirmations when the saved binding changes. */
  changed(botId: string): void;
  sharesEndpoint(url: string): boolean;
}

export class BotMemory {
  private readonly file: string;
  private settings?: Settings;
  private unreadable = false;
  private readonly failed = new Set<string>();
  private readonly checking = new Map<string, AbortController>();
  private readonly deps: BotMemoryDeps;

  constructor(deps: BotMemoryDeps) {
    this.deps = deps;
    this.file = join(deps.dataDir, "providers", "mem0", "bindings.json");
    try {
      const saved = settingsSchema.parse(JSON.parse(readFileSync(this.file, "utf8")));
      if (saved.environmentId === deps.environmentId) this.settings = saved;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.unreadable = true;
    }
  }

  status(botId: string): BotMemoryStatus {
    const binding = this.settings?.bots[botId];
    return { configured: Boolean(binding), enabled: binding?.enabled === true, failed: this.unreadable || this.failed.has(botId),
      url: this.settings?.url, userId: `maus-${this.deps.environmentId}`, agentId: botId };
  }

  private save(settings: Settings) {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.file, JSON.stringify(settings), { mode: 0o600 });
    this.settings = settings;
  }

  forget(botId: string) {
    this.checking.get(botId)?.abort();
    this.failed.delete(botId);
    if (!this.settings?.bots[botId]) return;
    const bots = { ...this.settings.bots };
    delete bots[botId];
    this.save({ ...this.settings, bots });
    this.deps.changed(botId);
  }

  async change(botId: string, input: MemoryChange, active: () => boolean) {
    if (this.unreadable) throw new MemoryRefusal(409, "The private memory settings could not be read.");
    if (!active() || !this.deps.botExists(botId)) throw new MemoryRefusal(403, "The bot or owner session is no longer available.");
    this.checking.get(botId)?.abort();
    const binding = this.settings?.bots[botId];
    if (!input.enabled) {
      if (this.settings && binding?.enabled) {
        this.save({ ...this.settings, bots: { ...this.settings.bots, [botId]: { ...binding, enabled: false, revision: randomUUID() } } });
        this.deps.changed(botId);
      }
      this.failed.delete(botId);
      return this.status(botId);
    }
    const url = input.url ? new URL(input.url).href : this.settings?.url;
    const token = input.token ?? binding?.token;
    if (!url || !token) throw new MemoryRefusal(400, "Enter the memory address and this bot's role credential.");
    // Never send a saved credential to a new address, even when this is the only bot.
    if (this.settings && Object.keys(this.settings.bots).length && url !== this.settings.url) throw new MemoryRefusal(409, "Use the configured workspace memory address.");
    if (this.deps.sharesEndpoint(url)) throw new MemoryRefusal(409, "Disable the shared MCP connection to this memory address first.");
    const attempt = new AbortController();
    this.checking.set(botId, attempt);
    try {
      const signal = AbortSignal.any([attempt.signal, AbortSignal.timeout(10_000)]);
      const tools = await verifyBinding(url, token, this.status(botId).userId, botId, signal);
      if (signal.aborted || !active() || !this.deps.botExists(botId)) throw new MemoryRefusal(409, "This memory setup has ended.");
      if ((this.settings && Object.keys(this.settings.bots).length && this.settings.url !== url) || this.deps.sharesEndpoint(url)) {
        throw new MemoryRefusal(409, "The workspace memory connection changed. Check it and try again.");
      }
      this.save({ environmentId: this.deps.environmentId, url, bots: { ...this.settings?.bots, [botId]: { token, enabled: true, revision: randomUUID(), tools } } });
      this.failed.delete(botId);
      this.deps.changed(botId);
      return this.status(botId);
    } catch (error) {
      if (!attempt.signal.aborted) this.failed.add(botId);
      if (error instanceof MemoryRefusal) throw error;
      throw new MemoryRefusal(502, "Could not verify this bot's connection to Mem0.");
    } finally {
      if (this.checking.get(botId) === attempt) this.checking.delete(botId);
    }
  }

  revision(botId: string): string | undefined {
    const binding = this.settings?.bots[botId];
    return binding?.enabled && this.settings && !this.deps.sharesEndpoint(this.settings.url) ? binding.revision : undefined;
  }

  async rpc(input: { botId: string; revision: string; frame: unknown; scope(): unknown; active(): boolean; signal: AbortSignal;
    confirm(id: string, signal: AbortSignal): Promise<boolean> }): Promise<unknown> {
    const { frame, botId, revision, signal } = input;
    const settings = this.settings, binding = settings?.bots[botId];
    const active = () => !signal.aborted && input.active() && binding?.enabled && this.revision(botId) === revision;
    if (!settings || !binding || !active()) throw new MemoryRefusal(403, "This memory connection is closed.");
    if (!isRecord(frame) || frame.jsonrpc !== "2.0" || typeof frame.method !== "string") throw new MemoryRefusal(400, "Invalid MCP request.");
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id: frame.id, result });
    if (!Object.hasOwn(frame, "id")) return undefined;
    const params = isRecord(frame.params) ? frame.params : {};
    if (frame.method === "initialize") return reply({ protocolVersion: params.protocolVersion ?? "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: BOT_MEMORY_SERVER, version: "1" } });
    if (frame.method === "ping") return reply({});
    const allowed = (name: string) => allowsTool(input.scope(), { kind: "mcp", server: BOT_MEMORY_SERVER, name });
    if (frame.method === "tools/list") return reply({ tools: binding.tools.filter(tool => allowed(tool.name)) });
    if (frame.method !== "tools/call") return { jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: "Method not found." } };
    const name = params.name;
    const args = params.arguments ?? {};
    if (typeof name !== "string" || !binding.tools.some(tool => tool.name === name) || !allowed(name) || !isRecord(args)) {
      return reply(rejected("This memory tool is unavailable."));
    }
    if (["userId", "agentId", "scope", "longTerm", "all", "confirm"].some(key => Object.hasOwn(args, key))) return reply(rejected("Use the memory partition assigned to this bot."));
    const identity = { userId: this.status(botId).userId, agentId: botId };
    if (name === "memory_delete" && Object.hasOwn(args, "memoryId")) {
      const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).safeParse(args.memoryId);
      if (!id.success || Object.keys(args).length !== 1) return reply(rejected("Delete one memory by its exact ID."));
      if (!await input.confirm(id.data, signal)) return reply(rejected("Deletion was not approved."));
    }
    const permitted = () => active() && allowed(name);
    if (!permitted()) return reply(rejected("This memory call is no longer authorized."));
    try {
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
      const result = await withClient(settings.url, binding.token, requestSignal, async client => {
        const idOnly = name === "memory_get" || name === "memory_update";
        if (idOnly || (name === "memory_delete" && "memoryId" in args)) await requireLongTermRole(client, identity.userId, botId, requestSignal);
        if (!permitted()) return rejected("This memory call is no longer authorized.");
        const scoped = idOnly ? args : { ...args, ...identity,
          ...(name === "memory_search" || name === "memory_list" || (name === "memory_delete" && "query" in args) ? { scope: "long-term" } : {}) };
        return rpcCall(client, name, scoped, requestSignal);
      });
      if (!permitted()) return reply(rejected("This memory call is no longer authorized."));
      this.failed.delete(botId);
      return reply(result);
    } catch {
      if (permitted()) this.failed.add(botId);
      return reply(rejected("Could not reach this bot's memories. Check the result before repeating a write."));
    }
  }
}
