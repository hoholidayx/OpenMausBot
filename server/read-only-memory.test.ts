import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { botFolder } from "./bot-folder.ts";
import { readOnlyMemoryPrompt } from "./read-only-memory.ts";

const BOT = "read-only-memory-probe";
const LAYER = "read-only-memory-probe--room-example";
const memoryPath = (id: string) => join(botFolder(id), "MEMORY.md");

function notes(id: string, text: string): void {
  mkdirSync(botFolder(id), { recursive: true });
  writeFileSync(memoryPath(id), text);
}

afterEach(() => {
  for (const id of [BOT, LAYER]) rmSync(botFolder(id), { recursive: true, force: true });
});

it("bounds the combined prompt and keeps UTF-8 character boundaries", () => {
  const limits = { maxEntries: 20, maxBytes: 4_000 };
  notes(LAYER, "# Room\n" + "- room\n".repeat(19));
  notes(BOT, "- first\n- second");
  const layered = readOnlyMemoryPrompt([LAYER, BOT], limits);
  expect(layered).toContain("first");
  expect(layered).not.toContain("second");
  notes(BOT, "🍊".repeat(70_000));
  const single = readOnlyMemoryPrompt([BOT], limits);
  expect(single.match(/🍊/gu)).toHaveLength(1_000);
  expect(single).not.toContain("�");
  expect(single).toContain('"truncated":true');
});

it.skipIf(process.platform === "win32")("ignores a linked note and a linked bot directory", () => {
  notes(BOT, "trusted note");
  mkdirSync(botFolder(LAYER), { recursive: true });
  symlinkSync(memoryPath(BOT), memoryPath(LAYER));
  expect(readOnlyMemoryPrompt([LAYER])).toBe("");
  rmSync(botFolder(LAYER), { recursive: true });
  symlinkSync(botFolder(BOT), botFolder(LAYER), "dir");
  expect(readOnlyMemoryPrompt([LAYER])).toBe("");
});
