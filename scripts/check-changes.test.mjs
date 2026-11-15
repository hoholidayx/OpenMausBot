import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { removeTempDir } from "../server/testing/cleanup.ts";
import { checkReadability } from "./check-changed-readability.mjs";
import { formatChangedStatements } from "./format-changed-statements.mjs";

const stale = "const inherited=  1;";

describe("formatting changed statements", () => {
  it("formats a nested statement and preserves surrounding code and line endings", async () => {
    const before = [
      "function run() {",
      `  ${stale}`,
      "  const active = 1;",
      "  return active;",
      "}",
      "",
    ].join("\n");
    const input = before.replace("active = 1", "active=  2").replaceAll("\n", "\r\n");
    const expected = input.replace("active=  2", "active = 2");
    expect(await formatChangedStatements("example.ts", before, input)).toEqual({
      text: expected,
      lines: [3],
    });
    expect(await formatChangedStatements("example.ts", before, expected)).toEqual({
      text: expected,
      lines: [],
    });
  });

  it("preserves an untouched sibling even if it shares a line with a changed statement", async () => {
    const before = `${stale} const active = 1;\n`;
    const input = `${stale} const active=   2;\n`;
    const formatted = await formatChangedStatements("example.ts", before, input);
    expect(formatted).toEqual({ text: `${stale} const active = 2;\n`, lines: [1] });
  });

  it("isolates a changed statement containing a large string on a shared line", async () => {
    const before = `${stale} const active = "${"a".repeat(2400)}";\n`;
    const input = `${stale} const active=   "${"b".repeat(2400)}";\n`;
    const formatted = await formatChangedStatements("example.ts", before, input);
    expect(formatted.text).toContain(stale);
    expect(formatted.text).not.toBe(input);
  });

  it("preserves an untouched child when a function header changes", async () => {
    const before = `function run(value: number) {\n  ${stale}\n  return value;\n}\n`;
    const input = before.replace("value: number", "value:  bigint");
    const formatted = await formatChangedStatements("example.ts", before, input);
    expect(formatted.text).toContain(`  ${stale}\n`);
  });
});

describe("readability regressions", () => {
  function example(checks) {
    const conditions = Array.from(
      { length: checks },
      (_, index) => `  if (value === ${index}) return value;`,
    );
    return [
      'const marker = "✓";',
      "export function run(value: number) {",
      ...conditions,
      "  return -1;",
      "}",
      "",
    ].join("\n");
  }

  it("reports new and increased complexity while accepting inherited and improved scores", () => {
    const file = "example.ts";
    const before = example(22);
    expect(checkReadability([{ file, before, source: example(23) }])).toEqual([
      expect.stringContaining("complexity of 24"),
    ]);
    expect(checkReadability([{ file, before: null, source: before }])).toHaveLength(1);
    expect(checkReadability([{ file, before, source: `\n${before}` }])).toEqual([]);
    expect(checkReadability([{ file, before, source: example(21) }])).toEqual([]);
  });

  it("reports additional nesting within an existing deeply nested function", () => {
    const file = "example.ts";
    const nested = (depth) => `export function run(value: number) {
${"if (value) {\n".repeat(depth)}return value;
${"}\n".repeat(depth)}return 0;
}`;
    const before = nested(5);
    expect(checkReadability([{ file, before, source: nested(6) }])).toEqual([
      expect.stringContaining("nested too deeply (6)"),
    ]);
    expect(checkReadability([{ file, before, source: nested(4) }])).toEqual([]);
  });
});

describe("local change commands in an isolated Git repository", () => {
  const dirs = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await removeTempDir(dir);
  });

  function checkout() {
    const cwd = mkdtempSync(join(tmpdir(), "omb check-changes-"));
    dirs.push(cwd);
    const env = { ...process.env };
    const git = (...args) =>
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.invalid",
          "-c",
          "commit.gpgsign=false",
          ...args,
        ],
        { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
    const files = [
      "check-changes.mjs",
      "check-changed-readability.mjs",
      "format-changed-statements.mjs",
    ];
    for (const file of files) {
      const destination = join(cwd, "scripts", file);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(fileURLToPath(new URL(file, import.meta.url)), destination);
    }
    const modules = fileURLToPath(new URL("../node_modules", import.meta.url));
    symlinkSync(modules, join(cwd, "node_modules"), "junction");
    git("init", "-q");
    writeFileSync(join(cwd, ".git", "info", "exclude"), "/scripts/\n/node_modules\n");
    git("config", "core.hooksPath", "scripts/git-hooks");
    git("-c", "core.hooksPath=", "commit", "-q", "--allow-empty", "-m", "init");
    const write = (file, content) => writeFileSync(join(cwd, file), content);
    const read = (file) => readFileSync(join(cwd, file), "utf8");
    const check = (...args) =>
      spawnSync(process.execPath, [join(cwd, "scripts", "check-changes.mjs"), ...args], {
        cwd,
        env,
        encoding: "utf8",
        timeout: 15_000,
      });
    return { cwd, env, git, read, write, check };
  }

  it("leaves formatting to an explicit request", () => {
    expect(existsSync(new URL("./git-hooks/pre-commit", import.meta.url))).toBe(false);
    const { git, read, write, check } = checkout();
    const file = "partially staged.ts";
    const unformatted = "export const active=  2;\n";
    write(file, unformatted);
    git("add", "--", file);
    expect(check("--staged").status).toBe(0);
    expect(check().status).toBe(0);
    git("commit", "-qm", "unformatted");
    expect(git("show", `HEAD:${file}`)).toBe(unformatted);
    write(file, "export const active=  3;\n");
    expect(check("--write").status).toBe(0);
    expect(read(file)).toBe("export const active = 3;\n");
  });

  it("uses the old blob of a staged rename even with a path filter", () => {
    const { git, read, write, check } = checkout();
    const inherited = Array.from(
      { length: 15 },
      (_, index) => `const previous${index}=  ${index};`,
    ).join("\n");
    write("old.ts", `${inherited}\nexport const active = 1;\n`);
    git("add", "old.ts");
    git("-c", "core.hooksPath=", "commit", "-qm", "upstream style");
    git("mv", "old.ts", "new.ts");
    write("new.ts", `${inherited}\nexport const active=  2;\n`);
    expect(check("--write", "--", "new.ts").status).toBe(0);
    expect(read("new.ts")).toBe(`${inherited}\nexport const active = 2;\n`);
    expect(git("show", ":new.ts")).toBe(`${inherited}\nexport const active = 1;\n`);
  });

  it("defers during a merge from any branch and resumes for ordinary commits", () => {
    const { git, write, check } = checkout();
    const localBranch = git("branch", "--show-current").trim();
    git("checkout", "-qb", "incoming");
    write("incoming.ts", "export const incoming=  1;\n");
    git("add", "incoming.ts");
    git("-c", "core.hooksPath=", "commit", "-qm", "incoming style");
    git("checkout", "-q", localBranch);
    write("local.ts", "export const local = 1;\n");
    git("add", "local.ts");
    git("commit", "-qm", "local change");
    git("merge", "--no-ff", "--no-commit", "incoming");
    expect(check("--staged").status).toBe(0);
    expect(check("--staged").stdout).toContain("deferred");
    expect(check().status).toBe(0);
    git("commit", "-qm", "merge");
    write("local.ts", "export const local=  2;\n");
    git("add", "local.ts");
    expect(check("--staged").status).toBe(0);
    expect(check("--write").stdout).toContain("Formatted changed statements");
  });

  it("does not format or block a conflicted merge", () => {
    const { git, read, write, check } = checkout();
    write("shared.ts", "export const value = 0;\n");
    git("add", "shared.ts");
    git("commit", "-qm", "base");
    const localBranch = git("branch", "--show-current").trim();
    git("checkout", "-qb", "incoming");
    write("shared.ts", "export const value = 1;\n");
    git("commit", "-qam", "incoming");
    git("checkout", "-q", localBranch);
    write("shared.ts", "export const value = 2;\n");
    git("commit", "-qam", "local");
    expect(() => git("merge", "incoming")).toThrow();
    const conflicted = read("shared.ts");
    expect(conflicted).toContain("<<<<<<<");
    expect(check("--write").stdout).toContain("deferred");
    expect(read("shared.ts")).toBe(conflicted);
    write("shared.ts", "export const value=  3;\n");
    git("add", "shared.ts");
    git("commit", "-qm", "resolve merge");
    expect(git("status", "--porcelain")).toBe("");
  });

  it.each(["--merge", "--apply"])(
    "does not block a %s rebase conflict or its continuation",
    (mode) => {
      const { git, read, write, check } = checkout();
      write("shared.ts", "export const value = 0;\n");
      git("add", "shared.ts");
      git("commit", "-qm", "base");
      const localBranch = git("branch", "--show-current").trim();
      git("checkout", "-qb", "incoming");
      write("shared.ts", "export const value = 1;\n");
      git("commit", "-qam", "incoming");
      git("checkout", "-q", localBranch);
      write("shared.ts", "export const value = 2;\n");
      git("commit", "-qam", "local");
      expect(() => git("rebase", mode, "incoming")).toThrow();
      const conflicted = read("shared.ts");
      expect(conflicted).toContain("<<<<<<<");
      expect(check("--write").stdout).toContain("deferred");
      expect(read("shared.ts")).toBe(conflicted);
      write("shared.ts", "export const value=  3;\n");
      git("add", "shared.ts");
      expect(check("--staged").stdout).toContain("deferred");
      git("-c", "core.editor=true", "rebase", "--continue");
      write("next.ts", "export const next=  1;\n");
      git("add", "next.ts");
      expect(check("--write").stdout).toContain("Formatted changed statements");
    },
  );

  it("defers a conflicted cherry-pick until it continues", () => {
    const { git, read, write, check } = checkout();
    write("shared.ts", "export const value = 0;\n");
    git("add", "shared.ts");
    git("commit", "-qm", "base");
    const localBranch = git("branch", "--show-current").trim();
    git("checkout", "-qb", "incoming");
    write("shared.ts", "export const value = 1;\n");
    git("commit", "-qam", "incoming");
    const incoming = git("rev-parse", "HEAD").trim();
    git("checkout", "-q", localBranch);
    write("shared.ts", "export const value = 2;\n");
    git("commit", "-qam", "local");
    expect(() => git("cherry-pick", incoming)).toThrow();
    const conflicted = read("shared.ts");
    expect(check("--write").stdout).toContain("deferred");
    expect(read("shared.ts")).toBe(conflicted);
    write("shared.ts", "export const value=  3;\n");
    git("add", "shared.ts");
    git("-c", "core.editor=true", "cherry-pick", "--continue");
    expect(git("status", "--porcelain")).toBe("");
  });

  it("defers a conflicted revert until it continues", () => {
    const { git, read, write, check } = checkout();
    write("shared.ts", "export const value = 0;\n");
    git("add", "shared.ts");
    git("commit", "-qm", "base");
    write("shared.ts", "export const value = 1;\n");
    git("commit", "-qam", "first change");
    const first = git("rev-parse", "HEAD").trim();
    write("shared.ts", "export const value = 2;\n");
    git("commit", "-qam", "second change");
    expect(() => git("revert", "--no-edit", first)).toThrow();
    const conflicted = read("shared.ts");
    expect(check("--write").stdout).toContain("deferred");
    expect(read("shared.ts")).toBe(conflicted);
    write("shared.ts", "export const value=  3;\n");
    git("add", "shared.ts");
    git("-c", "core.editor=true", "revert", "--continue");
    expect(git("status", "--porcelain")).toBe("");
  });

  it("defers unmerged paths even when no merge marker remains", () => {
    const { git, read, write, check } = checkout();
    write("shared.ts", "export const value = 0;\n");
    git("add", "shared.ts");
    git("commit", "-qm", "base");
    const localBranch = git("branch", "--show-current").trim();
    git("checkout", "-qb", "incoming");
    write("shared.ts", "export const value = 1;\n");
    git("commit", "-qam", "incoming");
    git("checkout", "-q", localBranch);
    write("shared.ts", "export const value = 2;\n");
    git("commit", "-qam", "local");
    expect(() => git("merge", "incoming")).toThrow();
    git("merge", "--quit");
    const conflicted = read("shared.ts");
    expect(check("--write").stdout).toContain("unmerged paths");
    expect(read("shared.ts")).toBe(conflicted);
  });

  it("resumes explicit formatting after an aborted conflict", () => {
    const { git, write, check } = checkout();
    write("shared.ts", "export const value = 0;\n");
    git("add", "shared.ts");
    git("commit", "-qm", "base");
    const localBranch = git("branch", "--show-current").trim();
    git("checkout", "-qb", "incoming");
    write("shared.ts", "export const value = 1;\n");
    git("commit", "-qam", "incoming");
    git("checkout", "-q", localBranch);
    write("shared.ts", "export const value = 2;\n");
    git("commit", "-qam", "local");
    expect(() => git("merge", "incoming")).toThrow();
    expect(check().stdout).toContain("deferred");
    git("merge", "--abort");
    write("next.ts", "export const next=  1;\n");
    git("add", "next.ts");
    expect(check("--write").stdout).toContain("Formatted changed statements");
  });

  it("finds operation state in a linked worktree", () => {
    const { cwd, env, git, write } = checkout();
    git("checkout", "-qb", "incoming");
    write("incoming.ts", "export const incoming=  1;\n");
    git("add", "incoming.ts");
    git("-c", "core.hooksPath=", "commit", "-qm", "incoming");
    const incoming = git("rev-parse", "HEAD").trim();
    git("checkout", "-q", "--detach", "HEAD^");
    const linked = join(cwd, "linked");
    git("worktree", "add", "--detach", linked, "HEAD");
    cpSync(join(cwd, "scripts"), join(linked, "scripts"), { recursive: true });
    symlinkSync(join(cwd, "node_modules"), join(linked, "node_modules"), "junction");
    git("-C", linked, "merge", "--no-ff", "--no-commit", incoming);
    const result = spawnSync(process.execPath, [join(linked, "scripts", "check-changes.mjs")], {
      cwd: linked,
      env,
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("deferred");
    git("-C", linked, "merge", "--abort");
    git("worktree", "remove", "--force", linked);
  });
});
