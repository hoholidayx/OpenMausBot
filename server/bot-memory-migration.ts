import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import { BotMemory, verifyMemoryRole } from "./bot-memory.ts";
import { acquireDataDirLease } from "./data-dir-lease.ts";
import { isRemoteMcpServer, parseStoredMcpServer } from "./mcp-registry.ts";

const object = z.record(z.string(), z.unknown());
const choices = z.array(z.object({ id: z.string(), name: z.string(), mcpServers: z.array(z.string()).nullable().optional() }));
const backup = z.object({ version: z.literal(1), environmentId: z.uuid(), url: z.string(), entry: object, bots: choices });
type Backup = z.infer<typeof backup>;
type Action = "inspect" | "disable" | "restore";

function readJson(file: string) { return JSON.parse(readFileSync(file, "utf8")) as unknown; }

function readBackup(file: string): Backup | undefined {
  try { return backup.parse(readJson(file)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error("The private migration backup cannot be read.");
  }
}

function legacyRole(raw: unknown, endpoint: string) {
  const parsed = parseStoredMcpServer("mem0", raw);
  if (!parsed.ok || !isRemoteMcpServer(parsed.server)) return;
  const entry = parsed.server;
  if (entry.bot || entry.runsOn || entry.oauth || entry.type !== "http" || new URL(entry.url).href !== endpoint) return;
  const headers = Object.entries(entry.headers ?? {});
  const token = headers.length === 1 && headers[0]![0].toLowerCase() === "authorization" && /^Bearer ([!-~]+)$/.exec(headers[0]![1])?.[1];
  return token ? { token, enabled: entry.enabled } : undefined;
}

/** The NAS role and the saved source entry must both still match before the shared grant changes. */
export async function migrateSharedMemory(dataDir: string, endpoint: string, action: Action) {
  const url = new URL(endpoint);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Supply the HTTP(S) address of the old Mem0 MCP endpoint.");
  const environmentId = z.uuid().parse(readFileSync(join(dataDir, "environment-id"), "utf8").trim());
  const lease = action === "inspect" ? undefined : acquireDataDirLease(dataDir);
  try {
    const configFile = join(dataDir, "config.json");
    const config = object.parse(readJson(configFile));
    const servers = object.parse(config.mcpServers ?? {});
    const raw = servers.mem0;
    const role = raw ? legacyRole(raw, url.href) : undefined;
    if (!role) return { state: raw ? "unrelated" : "absent" };
    const entry = object.parse(raw);
    const bots = choices.parse(readJson(join(dataDir, "bots.json")));
    const file = join(dataDir, "providers", "mem0", "legacy-workspace.json");
    const saved = readBackup(file);
    if (saved && (saved.environmentId !== environmentId || saved.url !== url.href ||
        !isDeepStrictEqual({ ...saved.entry, enabled: false }, { ...entry, enabled: false }))) {
      throw new Error("The old connection has changed since the private backup. Review it before switching.");
    }
    const report = { userId: "maus-" + environmentId, agentId: "workspace", bots };
    if (saved && !role.enabled && action !== "restore") return { state: "disabled", ...report };
    try {
      await verifyMemoryRole(url.href, role.token, report.userId, "workspace", AbortSignal.timeout(10_000));
    } catch { throw new Error("Could not verify the fixed workspace role on this endpoint. The saved configuration was left as it was."); }
    if (action === "inspect") return { state: role.enabled ? "verified" : "already-off", ...report };
    if (action === "restore") {
      if (!saved) throw new Error("A private backup from this installation is required to restore the shared connection.");
      const memory = new BotMemory({ dataDir, environmentId, botExists: () => false, sharesEndpoint: () => false, changed: () => {} });
      if (!memory.mayRestoreShared()) throw new Error("Turn off the per-bot bindings and check the private settings before restoring shared access.");
      const excluded = new Set(saved.bots.filter(bot => bot.mcpServers && !bot.mcpServers.includes("mem0")).map(bot => bot.id));
      if (bots.some(bot => excluded.has(bot.id) && (!bot.mcpServers || bot.mcpServers.includes("mem0")))) {
        throw new Error("A previously excluded bot now inherits shared memory. Restore its explicit exclusion first.");
      }
      if (!isDeepStrictEqual(entry, saved.entry)) writeFileAtomic(configFile, JSON.stringify({ ...config, mcpServers: { ...servers, mem0: saved.entry } }, null, 2) + "\n", { mode: 0o600 });
      return { state: "restored", ...report };
    }
    if (!saved) {
      mkdirSync(dirname(file), { mode: 0o700, recursive: true });
      writeFileAtomic(file, JSON.stringify({ version: 1, environmentId, url: url.href, entry, bots }, null, 2) + "\n", { mode: 0o600 });
    }
    if (role.enabled) writeFileAtomic(configFile, JSON.stringify({ ...config, mcpServers: { ...servers, mem0: { ...entry, enabled: false } } }, null, 2) + "\n", { mode: 0o600 });
    return { state: "disabled", ...report };
  } finally { lease?.release(); }
}
