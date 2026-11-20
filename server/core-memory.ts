import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { CoreMemoryEdit, CoreMemoryView } from "../shared/core-memory.ts";
import { writeFileAtomic } from "./atomic.ts";
import { BOTS_DIR, botFolder } from "./bot-folder.ts";
import { dreamTools } from "./dream-tools.ts";
import { prefixBytes } from "./context-rebuild.ts";

export const smallDreamFixture = process.env.OMB_TEST_SEALED_PATH === "1" && process.env.OMB_TEST_CORE_MEMORY === "1";
export const coreLimits = smallDreamFixture ? { maxEntries: 20, maxBytes: 4_000 } : { maxEntries: 200, maxBytes: 40_000 };
type Limits = typeof coreLimits;
const bad = (message: string, status = 400) => Object.assign(new Error(message), { status });
const sentence = z.string().trim().min(1).regex(/^[^\r\n\0]+$/, "Use one line per entry").refine(text => !/^[-*+•]\s/.test(text), "Supply the sentence without a list marker");
export const coreEditSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("add"), text: sentence }).strict(),
  z.object({ action: z.literal("update"), oldText: z.string().min(1), text: sentence }).strict(),
  z.object({ action: z.literal("remove"), oldText: z.string().min(1) }).strict(),
]);

function memoryPath(id: string, createDirectory: boolean) {
  if (!/^[\w-]+$/.test(id)) throw bad("Invalid bot ID");
  const folder = botFolder(id);
  for (const dir of [BOTS_DIR, folder]) {
    const stat = lstatSync(dir, { throwIfNoEntry: false });
    if (stat && !stat.isDirectory()) throw bad("Unsafe bot notes directory");
    if (!stat && createDirectory) mkdirSync(dir, { mode: 0o700 });
  }
  return join(folder, "MEMORY.md");
}

export function readCoreSource(id: string, limit?: number): { text: string; truncated: boolean } {
  const path = memoryPath(id, false);
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { text: "", truncated: false };
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || !lstatSync(path).isFile()) throw bad("Expected a regular MEMORY.md file");
    if (limit === undefined) return { text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileSync(fd)), truncated: false };
    const buffer = Buffer.alloc(Math.min(stat.size, limit) + 1);
    let length = 0;
    while (length < buffer.length) {
      const n = readSync(fd, buffer, length, buffer.length - length, null);
      if (!n) break;
      length += n;
    }
    let end = Math.min(length, limit);
    while (end > 0 && end < length && (buffer[end] & 0xc0) === 0x80) end--;
    return { text: buffer.toString("utf8", 0, end), truncated: end < length };
  } finally { closeSync(fd); }
}

type Entry = { start: number; bodyStart: number; end: number; after: number; text: string };
function entriesIn(source: string): Entry[] {
  const entries: Entry[] = [];
  let fence = "";
  let entry: Entry | undefined;
  for (const match of source.matchAll(/([^\r\n]*)(\r\n|\n|\r|$)/g)) {
    const line = match[1];
    const start = match.index;
    const end = start + line.length;
    const marker = /^ {0,3}(\x60{3,}|~{3,})/.exec(line)?.[1];
    if (marker && (!fence || marker.startsWith(fence))) {
      fence = fence ? "" : marker;
      entry = undefined;
      continue;
    }
    if (fence) continue;
    const bullet = /^(?:[-*+•]|\d+[.)])[ \t]+(?=\S)/.exec(line);
    if (bullet) {
      entry = { start, bodyStart: start + bullet[0].length, end, after: end + match[2].length, text: "" };
      entries.push(entry);
    } else if (entry && /^[ \t]+\S/.test(line)) {
      entry.end = end;
      entry.after = end + match[2].length;
    } else {
      entry = undefined;
    }
  }
  for (const item of entries) item.text = source.slice(item.bodyStart, item.end);
  return entries;
}

export function boundedCoreNotes(source: string, limits: Limits) {
  const entries = entriesIn(source);
  const overflow = entries[limits.maxEntries];
  const text = prefixBytes(overflow ? source.slice(0, overflow.start) : source, limits.maxBytes);
  return { text, entries: entries.filter(item => item.end <= text.length), truncated: text !== source };
}

export function coreMemoryContext(id: string) {
  const source = readCoreSource(id, 256 * 1024);
  const { text, entries: items } = boundedCoreNotes(source.text, coreLimits);
  const prose: string[] = [];
  let start = 0;
  for (const item of items) {
    prose.push(text.slice(start, item.start));
    start = item.after;
  }
  const reference = (prose.join("") + text.slice(start)).trim();
  return { entries: items.map(item => item.text), ...(reference ? { reference } : {}) };
}

function view(source: string, limits: Limits): CoreMemoryView {
  return { entries: entriesIn(source).map(entry => entry.text), bytes: Buffer.byteLength(source), ...limits };
}

export function coreMemoryView(id: string, limits = coreLimits) {
  return view(readCoreSource(id).text, limits);
}

export function editCoreMemory(id: string, edit: CoreMemoryEdit, limits = coreLimits): CoreMemoryView {
  edit = coreEditSchema.parse(edit);
  const source = readCoreSource(id).text;
  const entries = entriesIn(source);
  let next: string;
  if (edit.action === "add") {
    const { text } = edit;
    if (entries.some(item => item.text === text)) return view(source, limits);
    const eol = source.includes("\r\n") ? "\r\n" : "\n";
    const separator = source && !/[\r\n]$/.test(source) ? eol : "";
    next = source + separator + "- " + text + eol;
  } else {
    const { oldText } = edit;
    const hits = entries.filter(item => item.text === oldText);
    if (hits.length !== 1) throw bad("The entry changed or is ambiguous. Read the current entries and try again.", 409);
    const item = hits[0];
    if (edit.action === "update") {
      if (edit.text === oldText) return view(source, limits);
      if (entries.some(other => other.text === edit.text)) throw bad("That entry already exists. Remove the redundant entry to merge them.", 409);
    }
    next = edit.action === "remove" ? source.slice(0, item.start) + source.slice(item.after)
      : source.slice(0, item.bodyStart) + edit.text + source.slice(item.end);
  }
  const result = view(next, limits);
  if (edit.action === "add" && result.entries.length !== entries.length + 1) throw bad("Close the Markdown block in MEMORY.md before adding an entry.", 409);
  if (result.entries.length > limits.maxEntries || result.bytes > limits.maxBytes) {
    const shrinking = result.entries.length <= entries.length && result.bytes < Buffer.byteLength(source);
    if (!shrinking) throw bad("Core memory is full. Shorten, merge or remove an entry first.", 409);
  }
  writeFileAtomic(memoryPath(id, true), next, { mode: 0o600 });
  return result;
}

export function dreamEdit(id: string, name: string, args: unknown): string {
  if (!dreamTools.some(tool => tool.function.name === name) || !args || typeof args !== "object" || "action" in args) {
    return "Unknown tool or invalid arguments. Use one of the three listed tools.";
  }
  const edit = coreEditSchema.safeParse({ ...args, action: name.slice(5) });
  if (!edit.success) return edit.error.issues[0].message;
  try {
    const view = editCoreMemory(id, edit.data);
    return JSON.stringify({ ok: true, entries: view.entries.length, bytes: view.bytes });
  } catch (error) {
    if (!(error instanceof Error) || !("status" in error)) throw error;
    return JSON.stringify({ error: error.message, entries: coreMemoryContext(id).entries });
  }
}
