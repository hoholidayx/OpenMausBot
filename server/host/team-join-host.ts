import { personalHints } from "../../shared/cloud-hints.ts";
import { personKey } from "../person-key.ts";
import type { SessionRecord } from "../sessions.ts";
import type { TeamWelcomeStore } from "../team-welcome.ts";

/** The onboarding record this person reads on a team: the welcome's own hints are theirs (shared/cloud-hints.ts). */
export function teamOnboarding<T extends { hintsSeen: string[] }>(onboarding: T, session: SessionRecord | null | undefined, welcome: Pick<TeamWelcomeStore, "read">): T {
  return { ...onboarding, hintsSeen: personalHints(onboarding.hintsSeen, session ? welcome.read(personKey(session)).hints : [], session?.teamRole === "owner") };
}
