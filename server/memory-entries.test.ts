import { describe, expect, it } from "vitest";

import { factIdentity, isExpired, isMemoryDate, lineFactIdentity, notebookIdentities, parseMemoryEntries, withoutExpired } from "./memory-entries.ts";


describe("memory entry grammar", () => {
  it("parses dates, sources, until marks and strike-throughs", () => {
    const text = [
      "# Memory",
      "- 2026-09-10 · from chat \"Plans\" · Exams this weekend · until 2026-09-14",
      "- 2026-09-11 · ~~Office is in Pune~~ · superseded 2026-09-12",
      "- 2026-09-12 · Office is in Mumbai · updated 2026-09-13",
      "a hand-written line",
    ].join("\n");
    const entries = parseMemoryEntries(text);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ line: 1, date: "2026-09-10", body: "Exams this weekend", until: "2026-09-14", struck: false });
    expect(entries[1]).toMatchObject({ body: "Office is in Pune", struck: true, until: null });
    expect(entries[2]).toMatchObject({ body: "Office is in Mumbai", struck: false });
  });

  it("gives an entry the lines under it: indented ones and a code block it opens, never a fence that does not close", () => {
    const lines = [
      "- 2026-09-01 · Deploy command:", "  ```sh", "  railway up", "", "  ```", "  run it from the repo root",
      "- 2026-09-02 · Older shape:", "```sh", "railway up", "```",
      "- 2026-09-03 · Snippet ```", "x", "```",
      "- 2026-09-04 · Code blocks start with ```",
      "## Notes",
      "- 2026-09-05 · plain",
      "a hand-written line",
    ];
    expect(parseMemoryEntries(lines.join("\n")).map((e) => [e.line, e.end])).toEqual([[0, 6], [6, 10], [10, 13], [13, 14], [15, 16]]);
    const loose = ["- 2026-09-01 · Code blocks start with ```", "- 2026-09-02 · next", "- 2026-09-03 · Deploy:", "```sh", "railway up", "```"];
    expect(parseMemoryEntries(loose.join("\n")).map((e) => [e.line, e.end])).toEqual([[0, 1], [1, 2], [2, 6]]);
  });

  it("expires a live entry only after its until day, never a struck one", () => {
    expect(isExpired({ until: "2026-09-14", struck: false }, "2026-09-14")).toBe(false);
    expect(isExpired({ until: "2026-09-14", struck: false }, "2026-09-15")).toBe(true);
    expect(isExpired({ until: "2026-09-14", struck: true }, "2026-09-20")).toBe(false);
    expect(isExpired({ until: null, struck: false }, "2099-01-01")).toBe(false);
    const hidden = withoutExpired("- 2026-09-10 · Exams this weekend · until 2026-09-14\n- 2026-09-10 · Likes tea\n", "2026-09-15");
    expect(hidden).toEqual({ text: "- 2026-09-10 · Likes tea\n", hidden: 1 });
  });

  it("accepts only real calendar dates", () => {
    expect(isMemoryDate("2026-09-30")).toBe(true);
    expect(isMemoryDate("2026-02-30")).toBe(false);
    expect(isMemoryDate("next week")).toBe(false);
    expect(isMemoryDate(20260930)).toBe(false);
  });
});

describe("fact identity keeps meaning", () => {
  it.each([
    ["Balance is -10", "Balance is 10"],
    ["Uses C++", "Uses C"],
    ["Rate is 1.5", "Rate is 15"],
    ["Config at /tmp/a.json", "Config at /tmp/b.json"],
    ["Key name is API_KEY", "Key name is api_key"],
    ["Budget is $100", "Budget is 100"],
    ["Version >= 2", "Version 2"],
  ])("%s and %s are different facts", (a, b) => {
    expect(factIdentity(a)).not.toBe(factIdentity(b));
  });

  it("treats whitespace, a bullet and a final full stop as the same fact", () => {
    expect(factIdentity("-  Prefers   short replies.")).toBe(factIdentity("Prefers short replies"));
  });

  it("reads a notebook's live facts, ignoring struck ones and entry prefixes", () => {
    const notebook = "- 2026-09-10 · from chat \"A\" · Likes tea · until 2026-10-01\n- 2026-09-10 · ~~Lives in Pune~~ · superseded 2026-09-11\n";
    const ids = notebookIdentities(notebook);
    expect(ids.has("Likes tea")).toBe(true);
    expect(ids.has("Lives in Pune")).toBe(false);
    expect(lineFactIdentity("- 2026-09-10 · Balance is -10")).toBe("Balance is -10");
  });
});
