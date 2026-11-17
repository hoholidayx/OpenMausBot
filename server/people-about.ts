import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { botAvatarUrlSchema } from "../shared/bot-avatar.ts";
import { writeFileAtomic } from "./atomic.ts";

export const PERSON_NAME_MAX = 120;
const PERSON = /^p_[\w-]{22}$/;
export const SEED_FIELDS = ["name", "avatarUrl"] as const;
export type SeedField = (typeof SEED_FIELDS)[number];
const profileRecord = z.object({
  version: z.literal(1),
  name: z.string().max(PERSON_NAME_MAX).optional(),
  email: z.string().max(320).optional(),
  avatarUrl: botAvatarUrlSchema.optional(),
  seeded: z.array(z.enum(SEED_FIELDS)).max(SEED_FIELDS.length).optional(),
}).strict();

export interface PersonProfile {
  name?: string;
  /** The address of the person's verified sign-in, kept so a turn can name them; a session's own claim always wins. */
  email?: string;
  avatarUrl?: string;
  /** The fields their own computer's profile already filled once (seedMemberProfile): never filled from there again. */
  seeded?: SeedField[];
}

/** A change to a person's profile: "" clears a field, an absent field is kept. */
export type PersonProfilePatch = { name?: string; email?: string; avatarUrl?: string; seeded?: SeedField[] };

export interface PeopleAbout {
  profile(person: string): PersonProfile;
  hasProfile(person: string): boolean;
  saveProfile(person: string, patch: PersonProfilePatch): PersonProfile;
}

export function createPeopleAbout(dataDir: string): PeopleAbout {
  const folder = (person: string) => {
    if (!PERSON.test(person)) throw new Error("not a person key");
    return join(dataDir, "people", person);
  };
  const ensureFolder = (person: string) => mkdirSync(folder(person), { recursive: true, mode: 0o700 });
  const profilePath = (person: string) => join(folder(person), "profile.json");
  const readProfile = (person: string): PersonProfile => {
    try {
      const path = profilePath(person);
      if (!existsSync(path)) return {};
      const { version: _version, ...profile } = profileRecord.parse(JSON.parse(readFileSync(path, "utf8")));
      return profile;
    } catch {
      return {};
    }
  };
  return {
    profile: readProfile,
    hasProfile(person) {
      try {
        return existsSync(profilePath(person));
      } catch {
        return false;
      }
    },
    saveProfile(person, patch) {
      const next: PersonProfile = { ...readProfile(person) };
      for (const key of ["name", "email", "avatarUrl"] as const) {
        const value = patch[key];
        if (value === undefined) continue;
        const clean = key === "name" ? value.replace(/\s+/g, " ").trim().slice(0, PERSON_NAME_MAX) : value.trim();
        if (clean) next[key] = clean;
        else delete next[key];
      }
      if (patch.seeded) next.seeded = [...new Set(patch.seeded)];
      const stored = profileRecord.parse({ version: 1, ...next });
      ensureFolder(person);
      writeFileAtomic(profilePath(person), JSON.stringify(stored) + "\n", { mode: 0o600 });
      return next;
    },
  };
}
