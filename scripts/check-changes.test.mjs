import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
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

describe("local change hooks in an isolated Git repository", () => {
  const dirs = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await removeTempDir(dir);
  });

  function checkout() {
    const cwd = mkdtempSync(join(tmpdir(), "omb check-changes-"));
    dirs.push(cwd);
    const env = { ...process.env };
    delete env.OMB_SKIP_HOOKS;
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
      "codex-stop-check.mjs",
      "git-hooks/pre-commit",
    ];
    for (const file of files) {
      const destination = join(cwd, "scripts", file);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(fileURLToPath(new URL(file, import.meta.url)), destination);
    }
    chmodSync(join(cwd, "scripts", "git-hooks", "pre-commit"), 0o755);
    const modules = fileURLToPath(new URL("../node_modules", import.meta.url));
    symlinkSync(modules, join(cwd, "node_modules"), "junction");
    git("init", "-q");
    writeFileSync(join(cwd, ".git", "info", "exclude"), "/scripts/\n/node_modules\n");
    git("config", "core.hooksPath", "scripts/git-hooks");
    git("-c", "core.hooksPath=", "commit", "-q", "--allow-empty", "-m", "init");
    const write = (file, content) => writeFileSync(join(cwd, file), content);
    const read = (file) => readFileSync(join(cwd, file), "utf8");
    const node = (script, args = [], input) =>
      spawnSync(process.execPath, [join(cwd, "scripts", script), ...args], {
        cwd,
        env,
        input,
        encoding: "utf8",
        timeout: 15_000,
      });
    const check = (...args) => node("check-changes.mjs", args);
    const stop = (active) => {
      const input = JSON.stringify({ stop_hook_active: active });
      if (process.platform === "win32") return node("codex-stop-check.mjs", [], input);
      const config = JSON.parse(
        readFileSync(new URL("../.codex/hooks.json", import.meta.url), "utf8"),
      );
      const { command } = config.hooks.Stop[0].hooks[0];
      return spawnSync("sh", ["-c", command], {
        cwd: join(cwd, "scripts"),
        env,
        input,
        encoding: "utf8",
        timeout: 15_000,
      });
    };
    return { git, read, write, check, stop };
  }

  it.skipIf(process.platform === "win32")(
    "blocks an unformatted index even with a clean checkout, and permits a clean index with unrelated dirty files",
    () => {
      const { git, read, write } = checkout();
      const file = "partially staged.ts";
      write(file, "export const active=  2;\n");
      git("add", "--", file);
      write(file, "export const active = 2;\n");
      expect(() => git("commit", "-qm", "bad")).toThrow(/format the changed statement/);
      expect(git("show", `:${file}`)).toBe("export const active=  2;\n");
      expect(read(file)).toBe("export const active = 2;\n");

      git("add", "--", file);
      write(file, "export const active=  3;\n");
      write("untracked.ts", "broken!!!\n");
      git("commit", "-qm", "good");
      expect(git("show", `HEAD:${file}`)).toBe("export const active = 2;\n");
      expect(read(file)).toBe("export const active=  3;\n");
    },
  );

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

  it("lets Codex retry once on failure and passes after the same formatter fixes the worktree", () => {
    const { read, write, check, stop } = checkout();
    write("new.ts", "export const active=  2;\n");
    expect(JSON.parse(stop(false).stdout)).toMatchObject({
      decision: "block",
      reason: expect.stringContaining("new.ts:1"),
    });
    expect(JSON.parse(stop(true).stdout)).toEqual({
      systemMessage: expect.stringContaining("new.ts:1"),
    });
    expect(check("--write").status).toBe(0);
    expect(read("new.ts")).toBe("export const active = 2;\n");
    expect(stop(false).stdout).toBe("");
  });
});
