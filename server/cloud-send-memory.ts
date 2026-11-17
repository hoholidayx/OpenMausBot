import { createHash } from "node:crypto";
import { z } from "zod";

import type { CloudOwner } from "./cloud-owner-lines.ts";
import { factIdentity, parseMemoryEntries } from "./memory-entries.ts";
import type { RequestAuth } from "./request-auth.ts";
import type { RouteContext } from "./routes/table.ts";
import { readSectionContext, readSections, sectionContextKey, writeSectionContext } from "./section-context.ts";
import type { BotRecord } from "./store.ts";

const MEMORY_BODY_MAX = 16 * 1024 * 1024;
const FRONTMATTER = /^---\n[\s\S]*?\n---\n/u;

export interface MoveMemoryDeps {
  bot(id: string): BotRecord | undefined;
  owner(auth: RequestAuth): CloudOwner | null;
}

/** One piece of a memory file as a merge compares it: a dated entry with the lines it runs over, or any other line. */
function blocks(text: string): Array<{ text: string; identity: string }> {
  const lines = text.split("\n");
  const entries = new Map(parseMemoryEntries(text).map((entry) => [entry.line, entry]));
  const out: Array<{ text: string; identity: string }> = [];
  for (let line = 0; line < lines.length;) {
    const entry = entries.get(line);
    if (entry) {
      out.push({ text: lines.slice(entry.line, entry.end).join("\n"), identity: `e:${factIdentity(entry.body)}` });
      line = entry.end;
      continue;
    }
    if (lines[line]!.trim()) out.push({ text: lines[line]!, identity: `l:${factIdentity(lines[line]!.replace(/~~/gu, ""))}` });
    line += 1;
  }
  return out;
}

/** The identities of a memory file's pieces, in short hashes: what a move's check compares. */
export function memoryLines(text: string): string[] {
  const body = text.replace(FRONTMATTER, "");
  return [...new Set(blocks(body).map((block) => createHash("sha256").update(block.identity).digest("hex").slice(0, 12)))];
}

/** My Cloud's file with each piece of this computer's it lacks added after its own, in order: the same fact, however it
 * was dated or marked since, counts once. A file My Cloud lacks arrives as it is. */
export function mergeMemoryText(theirs: string, mine: string): string {
  if (!theirs.trim()) return mine;
  const front = FRONTMATTER.exec(mine)?.[0] ?? "";
  const known = new Set(blocks(theirs.replace(FRONTMATTER, "")).map((block) => block.identity));
  const adding: string[] = [];
  for (const block of blocks(mine.slice(front.length))) {
    if (known.has(block.identity)) continue;
    known.add(block.identity);
    adding.push(block.text);
  }
  const base = !FRONTMATTER.test(theirs) && front ? `${front}${theirs}` : theirs;
  return adding.length ? `${base.replace(/\s*$/u, "")}\n${adding.join("\n")}\n` : base;
}

export function sectionsForMove(): Array<{ section: string; context: string; memory: [] }> {
  return ["", ...readSections()].flatMap((section) => {
    const context = readSectionContext(section);
    return context ? [{ section, context: context.text, memory: [] }] : [];
  });
}

const mergeSchema = z.object({
  v: z.literal(1),
  bot: z.string().regex(/^[\w-]{1,128}$/u).optional(),
  teams: z.array(z.object({ section: z.string().max(60), context: z.string().max(24_000).nullable(), memory: z.array(z.unknown()).max(2_000).optional() })).max(200).optional(),
});

function mergeSections(body: z.infer<typeof mergeSchema>) {
  const out = { files: 0, journal: 0, about: 0, teams: 0, failed: [] as string[] };
  for (const team of body.teams ?? []) {
    const section = sectionContextKey(team.section);
    if (team.context?.trim()) {
      const current = readSectionContext(section)?.text ?? "";
      const next = mergeMemoryText(current, team.context);
      if (next !== current) {
        try { writeSectionContext(section, next); out.teams++; } catch { out.failed.push(`team:${section}`); }
      }
    }
  }
  return out;
}

/** False when the path is not this route. */
export async function moveMemoryRoute(deps: MoveMemoryDeps, { req, res, path, method, url, auth, json, readBody }: RouteContext): Promise<boolean> {
  if (path !== "/api/cloud-send/memory") return false;
  res.setHeader("cache-control", "no-store");
  if (method === "GET") {
    const botId = url.searchParams.get("bot");
    if (botId === null) json(res, 200, { v: 1, about: { learned: [], removed: [] }, teams: sectionsForMove() });
    else if (!/^[\w-]{1,128}$/u.test(botId) || !deps.bot(botId)) json(res, 404, { error: "no such bot" });
    else json(res, 200, { v: 1, files: [], journal: [] });
    return true;
  }
  if (method !== "POST") { json(res, 405, { error: "method not allowed" }); return true; }
  if (!deps.owner(auth)) { json(res, 403, { error: "Only My Cloud's owner can import department context." }); return true; }
  const body = mergeSchema.safeParse(await readBody(req, MEMORY_BODY_MAX));
  if (!body.success) { json(res, 400, { error: "send { v: 1, teams }" }); return true; }
  if (body.data.bot && !deps.bot(body.data.bot)) { json(res, 409, { error: "This bot is not on My Cloud yet." }); return true; }
  json(res, 200, { v: 1, ...(mergeSections(body.data)) });
  return true;
}
