import { JEV_DEFAULT_BASE_URL } from "./decider/jev.ts";

export const ELEVENLABS_API_DEFAULT = "https://api.elevenlabs.io/v1";
export interface ServiceCredential {
  token: string;
  /** The only base URL this token is ever sent to. */
  api: string;
  included: boolean;
}

export const elevenLabsProviderApi = (env: NodeJS.ProcessEnv = process.env): string =>
  env.OMB_ELEVENLABS_API || ELEVENLABS_API_DEFAULT;

export function voiceCredential(own: string | undefined, env: NodeJS.ProcessEnv = process.env): ServiceCredential | null {
  return own ? { token: own, api: elevenLabsProviderApi(env), included: false } : null;
}

export function deciderCredential(own: string | undefined, ownBaseUrl: string | undefined): ServiceCredential | null {
  const token = own?.trim();
  return token ? { token, api: ownBaseUrl?.trim() || JEV_DEFAULT_BASE_URL, included: false } : null;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export const TREG_API_DEFAULT = "https://treg.to";
/** Security: the person's treg key goes only to treg (https), or to a loopback stand-in in development and tests. */
export function tregProviderApi(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.OMB_TREG_URL?.trim().replace(/\/+$/, "");
  if (!configured) return TREG_API_DEFAULT;
  try {
    const parsed = new URL(configured);
    return parsed.protocol === "https:" || (parsed.protocol === "http:" && LOOPBACK.has(parsed.hostname)) ? configured : TREG_API_DEFAULT;
  } catch {
    return TREG_API_DEFAULT;
  }
}

 export function researchCredential(ownKey: string | undefined, env: NodeJS.ProcessEnv = process.env): ServiceCredential | null {
  const own = ownKey?.trim();
  return own ? { token: own, api: tregProviderApi(env), included: false } : null;
}
