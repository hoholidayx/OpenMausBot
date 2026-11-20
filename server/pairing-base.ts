import { isPrivateHost } from "../shared/private-host.ts";
import { isLoopbackHost } from "./request-auth.ts";

/** Where a pairing link points: the configured address, else the address the asking session used when that is https
 * or a private network other devices can reach. A public http link is never minted, and neither is a loopback one. */
export function pairingLinkBase(configured: string | null, requestOrigin: string | null): string | null {
  if (configured) return configured;
  if (!requestOrigin) return null;
  let url: URL;
  try {
    url = new URL(requestOrigin);
  } catch {
    return null;
  }
  if (isLoopbackHost(url.host)) return null;
  return url.protocol === "https:" || (url.protocol === "http:" && isPrivateHost(url.hostname)) ? url.origin : null;
}
