import { describe, expect, it } from "vitest";
import { memoryLines, mergeMemoryText } from "./cloud-send-memory.ts";

describe("a memory file merged into My Cloud's", () => {
  const theirs = "# Notes\n- 2026-10-05 · from chat · Acme pays on the 5th. · updated 2026-10-06\n- 2026-10-04 · from chat · Prefers email.\n";
  const mine = "# Notes\n- 2026-10-01 · from chat · Acme pays on the 5th.\n- 2026-10-02 · from chat · Ship on Fridays.\n  with a second line\n- 2026-10-03 · from chat · ~~Old address~~ · superseded 2026-10-04\n";

  it("adds only the pieces My Cloud lacks, after its own and in order, each fact once however it was dated or marked", () => {
    const merged = mergeMemoryText(theirs, mine);
    expect(merged).toBe(`${theirs}- 2026-10-02 · from chat · Ship on Fridays.\n  with a second line\n- 2026-10-03 · from chat · ~~Old address~~ · superseded 2026-10-04\n`);
    expect(mergeMemoryText(merged, mine), "merging again changes nothing").toBe(merged);
    expect(mergeMemoryText("", mine), "a file My Cloud lacks arrives as it is").toBe(mine);
    expect(mergeMemoryText(theirs, theirs)).toBe(theirs);
  });

  it("keeps My Cloud's own front matter, and takes this computer's when it has none", () => {
    const front = "---\ntitle: Clients\n---\n";
    expect(mergeMemoryText(`${front}- 2026-10-01 · from chat · A.\n`, "---\ntitle: Other\n---\n- 2026-10-02 · from chat · B.\n")).toBe(`${front}- 2026-10-01 · from chat · A.\n- 2026-10-02 · from chat · B.\n`);
    expect(mergeMemoryText("- 2026-10-01 · from chat · A.\n", `${front}- 2026-10-02 · from chat · B.\n`)).toBe(`${front}- 2026-10-01 · from chat · A.\n- 2026-10-02 · from chat · B.\n`);
  });

  it("names the same pieces the same on both sides, which is what a move's check compares", () => {
    const here = memoryLines(mine);
    const there = new Set(memoryLines(mergeMemoryText(theirs, mine)));
    expect(here.every((line) => there.has(line))).toBe(true);
    expect(memoryLines(theirs).some((line) => !new Set(here).has(line))).toBe(true);
    expect(new Set(memoryLines("- 09:10 · from chat · Sent the invoice.\n- 09:10 · from chat · Sent the invoice.\n")).size).toBe(1);
  });
});
