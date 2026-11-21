import type { WireBot } from "./wire.ts";

export const MOBILE_API_VERSION = 1;
export const MOBILE_BOOTSTRAP_PATH = "/api/mobile/v1/bootstrap";

/** The paired viewer's direct-chat entry, in the same order as their bots. */
export interface MobilePartner extends Pick<WireBot, "id" | "name" | "color" | "avatarUrl"> {
  selectedThreadId: string | null;
}

export interface MobileBootstrap {
  version: typeof MOBILE_API_VERSION;
  bots: MobilePartner[];
}
