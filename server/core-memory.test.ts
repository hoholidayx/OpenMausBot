import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { botFolder } from "./bot-folder.ts";
import { coreLimits, coreMemoryContext, coreMemoryView, dreamEdit, editCoreMemory } from "./core-memory.ts";
import { readOnlyMemoryPrompt } from "./read-only-memory.ts";

const id = "dream-entries-test";
const path = join(botFolder(id), "MEMORY.md");
const fixture = { maxEntries: 20, maxBytes: 4_000 };
function seed(source: string) { mkdirSync(botFolder(id), { recursive: true }); writeFileSync(path, source); }
const source = () => readFileSync(path, "utf8");
afterEach(() => rmSync(botFolder(id), { recursive: true, force: true }));

it.each([fixture, { maxEntries: 200, maxBytes: 40_000 }])("publishes the last entry at both exact limits ($maxEntries / $maxBytes)", limits => {
  const lines = Array.from({ length: limits.maxEntries - 1 }, (_, i) => "- 条目 " + i);
  const prefix = ["# 手写标题", "跨行说明", ...lines, ""].join("\n");
  seed(prefix);
  const room = limits.maxBytes - Buffer.byteLength(prefix + "- 。\n");
  const last = "中".repeat(Math.floor(room / 3)) + "x".repeat(room % 3) + "。";
  const view = editCoreMemory(id, { action: "add", text: last }, limits);
  expect(view.entries).toHaveLength(limits.maxEntries);
  expect(view.bytes).toBe(limits.maxBytes);
  expect(readOnlyMemoryPrompt([id], limits)).toContain(last);
  expect(readOnlyMemoryPrompt([id], limits)).not.toContain('"truncated":true');
  expect(() => editCoreMemory(id, { action: "update", oldText: last, text: last + "A" }, limits)).toThrow(/full/);
  const after = source();
  expect(editCoreMemory(id, { action: "add", text: last }, limits)).toEqual(view);
  expect(source()).toBe(after);
});

it("enforces whichever limit comes first, counts the whole file, and allows oversized originals to shrink", () => {
  expect(coreLimits).toEqual({ maxEntries: 200, maxBytes: 40_000 });
  for (let i = 0; i < 20; i++) editCoreMemory(id, { action: "add", text: String(i) }, fixture);
  expect(coreMemoryView(id, fixture).bytes).toBeLessThan(100);
  expect(() => editCoreMemory(id, { action: "add", text: "21" }, fixture)).toThrow(/full/);
  seed(source() + "- extra\n");
  expect(() => editCoreMemory(id, { action: "update", oldText: "extra", text: "longer entry" }, fixture)).toThrow(/full/);
  expect(editCoreMemory(id, { action: "remove", oldText: "extra" }, fixture).entries).toHaveLength(20);
  seed("# " + "题".repeat(1333) + "\n- 过去\n");
  const saved = source();
  expect(() => editCoreMemory(id, { action: "add", text: "小" }, fixture)).toThrow(/full/);
  expect(source()).toBe(saved);
  const next = editCoreMemory(id, { action: "update", oldText: "过去", text: "现" }, fixture);
  expect(next.bytes).toBeGreaterThan(4_000);
  expect(next.bytes).toBe(Buffer.byteLength(saved) - 3);
});

it("preserves handwritten bytes and rejects stale and ambiguous complete matches", () => {
  const prefix = "# 计划\r\n手写段落\r\n~~~text\r\n- example\r\n~~~\r\n";
  seed(prefix + "* 名称\r\n  限定范围\r\n\r\n附注\r\n- 名称相似\r\n");
  expect(coreMemoryContext(id)).toMatchObject({ entries: ["名称\r\n  限定范围", "名称相似"], reference: expect.stringContaining("附注") });
  editCoreMemory(id, { action: "update", oldText: "名称\r\n  限定范围", text: "新名称" });
  expect(source()).toBe(prefix + "* 新名称\r\n\r\n附注\r\n- 名称相似\r\n");
  const stale = JSON.parse(dreamEdit(id, "core_update", { oldText: "名称", text: "别名" }));
  expect(stale.entries).toEqual(["新名称", "名称相似"]);
  editCoreMemory(id, { action: "remove", oldText: "新名称" });
  expect(source()).toBe(prefix + "\r\n附注\r\n- 名称相似\r\n");
  seed("- 相同\n- 相同\n");
  expect(() => editCoreMemory(id, { action: "remove", oldText: "相同" })).toThrow(/ambiguous/);
  const invalid = dreamEdit(id, "core_add", { text: "first\n- second" });
  expect(invalid).toContain("one line");
  expect(dreamEdit(id, "core_add", { text: "一条", path: "/tmp/other" })).toMatch(/Unrecognized/i);
  expect(source()).toBe("- 相同\n- 相同\n");
});
