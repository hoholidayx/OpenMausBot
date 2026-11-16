// OMB Cloud Pro home machine. The server binds 127.0.0.1 behind an edge proxy and every request carries X-Forwarded-*
// headers, so no network request is ever the loopback owner. The Admin never holds a session: it signs a request with the
// bootstrap secret (HMAC-SHA256 over method, path and query, timestamp, nonce and body hash). A valid pairing request opens
// one ordinary pairing window; a valid health request reads the content-free health report (server/cloud-health.ts).
// Nothing on a Cloud home is routed to a platform model gateway, except a free trial's Claude credit.
import { createHash, createHmac } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Surface } from "../shared/wire.ts";
import { writeFileAtomic } from "./atomic.ts";
import { hostedWorkspaceConfigured } from "./enterprise.ts";
import { type CloudTeam } from "./cloud-team.ts";
import { isLoopbackHost } from "./request-auth.ts";

/** Any of these switches the server into Cloud home mode; then all are required. */
export const CLOUD_HOME_KEYS = ["OMB_CLOUD_ROLE", "OMB_CLOUD_MACHINE_ID", "OMB_CLOUD_ADMIN_URL", "OMB_CLOUD_BOOTSTRAP_SECRET"] as const;
/** A platform model gateway's settings: a Cloud home logs one warning, and neither it nor anything it starts sees them. */
export const CLOUD_IGNORED_KEYS = ["OMB_HOSTED_MODEL_URL", "OMB_HOSTED_MODEL_TOKEN", "OMB_HOSTED_MODELS"] as const;
export const CLOUD_PAIRING_PATH = "/api/cloud/pairing";
export const CLOUD_HEALTH_PATH = "/api/cloud/health";
export const CLOUD_HOME_MARKER = ".omb-cloud-home.json";

export type CloudHomeRole = "home" | "team";

export interface CloudHomeConfig {
  /** `home`: one person's My Cloud. `team`: a Team Cloud several people use (docs/team-cloud.md). */
  role: CloudHomeRole;
  /** The team this machine is the home of; null on a My Cloud. */
  team: CloudTeam | null;
  machineId: string;
  adminOrigin: string;
  publicOrigin: string;
  /** The addresses this home answered at before a move to another provider (OMB_CLOUD_LEGACY_ORIGINS), each an exact https
   * origin. The old address forwards here with Host rewritten to `publicOrigin`'s name, so a page or client still on it
   * sends that address as its Origin, which counts as this home's own. Empty for a home that never moved. */
  legacyOrigins: string[];
  bootstrapSecret: string;
  warnings: string[];
}

export function cloudHomeConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return CLOUD_HOME_KEYS.some((key) => env[key] !== undefined);
}

function invalid(why: string): never {
  throw new Error(`Cloud home configuration is invalid: ${why}.`);
}

function exactHttpsOrigin(raw: string | undefined, name: string): string {
  let url: URL;
  try {
    if (!raw || raw !== raw.trim()) throw new Error();
    url = new URL(raw);
  } catch { return invalid(`${name} must be an https origin`); }
  if (url.protocol !== "https:" || url.username || url.password || (raw !== url.origin && raw !== `${url.origin}/`)) {
    invalid(`${name} must be an exact https origin with no path`);
  }
  return url.origin;
}

export const MAX_LEGACY_ORIGINS = 8;

/** OMB_CLOUD_LEGACY_ORIGINS, comma-separated: exact https origins only, never a loopback name (a loopback Origin means this
 * machine), at most MAX_LEGACY_ORIGINS; this home's own address among them is dropped. */
function legacyOrigins(raw: string | undefined, publicOrigin: string): string[] {
  const entries = (raw ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  if (entries.length > MAX_LEGACY_ORIGINS) invalid(`OMB_CLOUD_LEGACY_ORIGINS names more than ${MAX_LEGACY_ORIGINS} origins`);
  const origins = entries.map((entry) => exactHttpsOrigin(entry, "every OMB_CLOUD_LEGACY_ORIGINS entry"));
  if (origins.some((origin) => isLoopbackHost(new URL(origin).host))) invalid("OMB_CLOUD_LEGACY_ORIGINS must not name a loopback address");
  return [...new Set(origins)].filter((origin) => origin !== publicOrigin);
}

/** Null on any machine that is not a Cloud home; throws, so the server refuses to start, on a partial or invalid one. */
export function cloudHomeConfiguration(env: NodeJS.ProcessEnv = process.env): CloudHomeConfig | null {
  if (!cloudHomeConfigured(env)) return null;
  if (env.OMB_DESKTOP_PARENT === "1") invalid("the desktop app cannot run as a Cloud home machine");
  if (hostedWorkspaceConfigured(env)) invalid("a Cloud home is not a hosted team workspace; remove OMB_ADMIN_URL, OMB_ADMIN_WORKSPACE and OMB_ADMIN_MEMBERSHIP");
  const role = env.OMB_CLOUD_ROLE;
  if (role !== "home" && role !== "team") invalid('OMB_CLOUD_ROLE must be "home" or "team"; this image runs the home machine');
  const team = role === "team" ? cloudTeamConfiguration(env) : null;
  const machineId = env.OMB_CLOUD_MACHINE_ID ?? "";
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/.test(machineId)) invalid("OMB_CLOUD_MACHINE_ID must be the Admin's machine id (letters, digits, dashes)");
  const adminOrigin = exactHttpsOrigin(env.OMB_CLOUD_ADMIN_URL, "OMB_CLOUD_ADMIN_URL");
  const publicOrigin = exactHttpsOrigin(env.OMB_PUBLIC_URL, "OMB_PUBLIC_URL");
  const legacy = legacyOrigins(env.OMB_CLOUD_LEGACY_ORIGINS, publicOrigin);
  const bootstrapSecret = env.OMB_CLOUD_BOOTSTRAP_SECRET ?? "";
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(bootstrapSecret)) invalid("OMB_CLOUD_BOOTSTRAP_SECRET must be at least 256 bits of base64url");
  const warnings: string[] = [];
  const ignored = CLOUD_IGNORED_KEYS.filter((key) => env[key] !== undefined);
  if (ignored.length) warnings.push(`ignoring ${ignored.join(", ")}: Cloud Pro includes no AI; people sign in with their own Claude or ChatGPT account, or an API key`);
  return { role, team, machineId, adminOrigin, publicOrigin, legacyOrigins: legacy, bootstrapSecret, warnings };
}

const TEAM_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
// oxlint-disable-next-line no-control-regex
const TEAM_NAME = /^[^\x00-\x1f\x7f]{1,80}$/;
const TEAM_LANGUAGE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/;

/** A Team Cloud boots with the Admin's team id and the team's name, and answers by that name. */
function cloudTeamConfiguration(env: NodeJS.ProcessEnv): CloudTeam {
  const id = env.OMB_CLOUD_TEAM_ID ?? "";
  if (!TEAM_ID.test(id)) invalid("OMB_CLOUD_TEAM_ID must be the Admin's team id (letters, digits, dashes)");
  const name = (env.OMB_CLOUD_TEAM_NAME ?? "").trim();
  if (!TEAM_NAME.test(name)) invalid("OMB_CLOUD_TEAM_NAME must be the team's name (1 to 80 characters)");
  // A language the app doesn't know is ignored rather than refused: the Team Cloud still boots, in its own default.
  const language = (env.OMB_CLOUD_TEAM_LANGUAGE ?? "").trim().toLowerCase();
  return { id, name, ...(TEAM_LANGUAGE.test(language) ? { language } : {}) };
}

export { CLOUD_HOME_SECRET_KEYS, CLOUD_SECRETS_FD_ENV, cloudHomeSecrets, takeCloudSecrets, withoutCloudSecrets } from "./cloud-secrets.ts";

export function withoutIgnoredCloudKeys(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const kept = { ...env };
  for (const key of CLOUD_IGNORED_KEYS) delete kept[key];
  return kept;
}

export { cloudHomeOffersPlace } from "../shared/cloud-home.ts";

/** In the person's words; a turn's error shows 160 characters, so each fits. */
export function cloudHomePlaceRefusal(place: Surface): string | undefined {
  if (place === "local") return "This computer isn't a place in the Cloud. Set Works on to Auto, Cloud desktop or Browser; your own computer is reached while OpenMausBot is open on it.";
  if (place === "vm") return "Cloud bots can't use a private desktop. Set Works on to Auto, Cloud desktop or Browser.";
  return undefined;
}

/** Recorded once in this Cloud's own onboarding record, which never travels with Move to Cloud, so moved-in turns never count. */
export function firstCloudTurnPatch(turn: { cloudHome: boolean; recorded: string | undefined; ok: boolean; known: boolean; now?: Date }): { onboarding: { firstTurnAt: string } } | null {
  if (!turn.cloudHome || turn.recorded || !turn.ok || !turn.known) return null;
  return { onboarding: { firstTurnAt: (turn.now ?? new Date()).toISOString() } };
}

/** Must match openmaus-cloud's cloudRequestSignature. `target` is the path and query exactly as the Admin sent them. */
export function cloudRequestSignature(secret: string, timestamp: string, nonce: string, method: string, target: string, body: Buffer | string): string {
  const bodyHash = createHash("sha256").update(body).digest("base64url");
  return createHmac("sha256", secret).update(`v1\n${timestamp}\n${nonce}\n${method}\n${target}\n${bodyHash}`).digest("base64url");
}

export function cloudPairingSignature(secret: string, timestamp: string, nonce: string, body: Buffer | string): string {
  return cloudRequestSignature(secret, timestamp, nonce, "POST", CLOUD_PAIRING_PATH, body);
}

// useradd seeds these shell files and a fresh Fly volume carries lost+found; anything else is someone's data.
const ADOPTABLE = new Set(["lost+found", ".bash_logout", ".bashrc", ".profile"]);

/** Binds the volume to this machine on first boot and refuses any other machine's after; never deletes or rewrites data. */
export function prepareCloudHomeVolume(home: string, machineId: string): "new" | "existing" {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const marker = join(home, CLOUD_HOME_MARKER);
  if (existsSync(marker)) {
    const stat = lstatSync(marker);
    let saved: unknown;
    try {
      if (!stat.isFile() || stat.size > 4096) throw new Error();
      saved = JSON.parse(readFileSync(marker, "utf8"));
    } catch { throw new Error("This volume's Cloud marker is unreadable. No data was changed."); }
    if ((saved as { machine?: unknown })?.machine !== machineId) throw new Error("This volume belongs to another Cloud machine. No data was changed.");
    return "existing";
  }
  if (readdirSync(home).some((name) => !ADOPTABLE.has(name))) {
    throw new Error("Refusing to adopt a data volume that was not made for this Cloud machine. No data was changed.");
  }
  writeFileAtomic(marker, JSON.stringify({ version: 1, machine: machineId }) + "\n", { mode: 0o600 });
  return "new";
}

/** What the edge proxy may answer for: the machine's own public name. */
export function cloudHomeHost(config: Pick<CloudHomeConfig, "publicOrigin">): string {
  return new URL(config.publicOrigin).hostname;
}
