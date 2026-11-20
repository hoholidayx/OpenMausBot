import { createHash } from "node:crypto";

import type { SessionRecord } from "./sessions.ts";

const hashed = (basis: string) => `p_${createHash("sha256").update(basis).digest("base64url").slice(0, 22)}`;

export const localUserId = (environmentId: string): string => hashed(`local-owner:${environmentId}`);

/** Hashed, so a message or a thread can carry it without handing other members a session id. */
export function personKey(session: Pick<SessionRecord, "id" | "email" | "userId">): string {
  if (session.userId?.startsWith("p_") && !session.email) return session.userId;
  return hashed(session.email ? `email:${session.email.trim().toLowerCase()}` : `session:${session.id}`);
}

/** A person another app relays (the Slack worker's onBehalfOf): the key their own session would have, by email,
 * or one by name when the app knows no email. */
export function relayedPersonKey(person: { email?: string; name?: string }): string {
  return person.email ? personKey({ id: "", email: person.email }) : hashed(`name:${(person.name ?? "").trim()}`);
}

type DeviceSession = Pick<SessionRecord, "id" | "userId" | "email">;

/** Persisted lender key used by the owner's shared computers. */
export const OWN_SERVER_LENDER = hashed("lender:own-server-devices");

export function lendingPersonKey(session: DeviceSession, ownerId: string): string {
  return session.userId === ownerId ? OWN_SERVER_LENDER : personKey(session);
}

export function lendingPerson(person: string | null, ownerId: string, sessions: () => readonly DeviceSession[]): string | null {
  if (!person) return null;
  if (person === ownerId) return OWN_SERVER_LENDER;
  const paired = sessions().some(device => device.userId === ownerId && personKey({ id: device.id }) === person);
  return paired ? OWN_SERVER_LENDER : person;
}
