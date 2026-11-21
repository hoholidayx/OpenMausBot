import type { WireMessagePage } from "./responses.ts";
import type { SteerQueueReason, WireBot, WireMessage } from "./wire.ts";

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

/** GET /api/threads/:threadId/messages with a positive limit; before excludes its message. */
export interface MobileMessagePage<Message = WireMessage> extends WireMessagePage<Message> {
  hasMore: boolean;
}

/** POST /api/bots/:botId/messages for an ordinary text send pinned by the mobile client. */
export interface MobileTextSend {
  threadId: string;
  sendId: string;
  text: string;
  followUp?: "queue";
}

/** HTTP 202 acknowledges the user's stored line or a queue entry that can later produce one. */
export type MobileTextReceipt<Message = WireMessage> =
  | { ok: true; threadId: string; message: Message; steered?: true }
  | { ok: true; queued: true; queueId: string; threadId: string; reason?: SteerQueueReason; why?: string };
