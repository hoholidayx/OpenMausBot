import type { IncomingMessage, ServerResponse } from "node:http";
import type { RequestAuth } from "./request-auth.ts";
import type { SessionRegistry } from "./sessions.ts";

export interface EditionStatus {
  edition: "oss" | "enterprise";
  /** Enterprise only: who the license was issued to. */
  customer?: string;
  /** Entitlement ids the license grants (sorted). Empty for the open-source edition. */
  features: string[];
  /** Enterprise only: ISO date the license stops working, null for perpetual. */
  expiresAt?: string | null;
  /** With an expiry only: whole days until `expiresAt`; zero or negative once the grace period runs. */
  expiresInDays?: number;
  /** Enterprise in its grace period only: when the features stop. */
  graceEndsAt?: string;
  /** Why this is not the enterprise edition although something hinted it should be, or that the key needs renewing. */
  notice?: string;
}

export interface WorkspaceAccessOptions {
  sessions: SessionRegistry;
  cookieName: string;
  closeSessionStreams(sessionId: string): void;
  entitled(): boolean;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface WorkspaceAccess {
  handlePublic(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
  authorize(req: IncomingMessage, auth: RequestAuth): Promise<{ status: 401 | 403 | 503; error: string } | null>;
  revalidate(): Promise<void>;
}

export function hostedWorkspaceConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OMB_ADMIN_URL !== undefined || env.OMB_ADMIN_WORKSPACE !== undefined || env.OMB_ADMIN_MEMBERSHIP !== undefined;
}

/** A partial setting is never standalone. */
export function hostedWorkspaceConfiguration(env: NodeJS.ProcessEnv = process.env): { admin: URL; tenant: URL; workspace: string; portalMembership: boolean } | null {
  try {
    const origin = (raw: string | undefined) => {
      if (!raw || raw !== raw.trim()) throw new Error("missing origin");
      const url = new URL(raw);
      if (url.protocol !== "https:" || (raw !== url.origin && raw !== `${url.origin}/`)) throw new Error("invalid origin");
      return url;
    };
    if (!/^[a-z][a-z0-9-]{1,30}$/.test(env.OMB_ADMIN_WORKSPACE ?? "")) return null;
    if (env.OMB_ADMIN_MEMBERSHIP !== undefined && !["local", "portal"].includes(env.OMB_ADMIN_MEMBERSHIP)) return null;
    return { admin: origin(env.OMB_ADMIN_URL), tenant: origin(env.OMB_PUBLIC_URL), workspace: env.OMB_ADMIN_WORKSPACE!, portalMembership: env.OMB_ADMIN_MEMBERSHIP === "portal" };
  } catch { return null; }
}

/** A hosted workspace never issues pairing codes or email sign-in: people come in through the portal. */
export function workspaceMembership(env: NodeJS.ProcessEnv = process.env):
  { authority: "local" | "portal"; pairingCodes: boolean; peopleUrl?: string } {
  const hosted = hostedWorkspaceConfiguration(env);
  const pairingCodes = !hostedWorkspaceConfigured(env);
  if (!hosted?.portalMembership) return { authority: "local", pairingCodes };
  const people = new URL("/people", hosted.admin);
  people.search = new URLSearchParams({ workspace: hosted.workspace }).toString();
  return { authority: "portal", pairingCodes, peopleUrl: people.href };
}

/** Only on a dedicated, portal-managed server; never an HTTP setting or a desktop grant. */
export function sharedWorkspaceFullAccessConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OMB_SHARED_WORKSPACE_FULL_ACCESS === "1" && env.OMB_DESKTOP_PARENT !== "1" &&
    hostedWorkspaceConfiguration(env)?.portalMembership === true;
}

/** A configured server without this hook must refuse hosted access, never fall back to email or QR credentials. */
export function createWorkspaceAccess(_options: Omit<WorkspaceAccessOptions, "entitled">): WorkspaceAccess | null {
  return null;
}

export function editionStatus(): EditionStatus {
  return { edition: "oss", features: [] };
}

export function editionForMembers(status: EditionStatus): EditionStatus {
  return status;
}

export function entitled(_feature: string): boolean {
  return false;
}

export function editionForSettings(status: EditionStatus) {
  return status;
}
