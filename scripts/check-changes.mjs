import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = fileURLToPath(new URL("../", import.meta.url));
const codeFile = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const gitOptions = { cwd: root, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] };
const git = (...args) => execFileSync("git", ["--literal-pathspecs", ...args], gitOptions);
const nullFields = (buffer) => buffer.toString("utf8").split("\0").slice(0, -1);
const regular = (mode) => mode === "100644" || mode === "100755";
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function diffArgs(staged) {
  if (staged) return ["--cached"];
  const head = spawnSync("git", ["rev-parse", "--verify", "--quiet", "HEAD"], gitOptions);
  if (head.error) throw head.error;
  if (head.status === 0) return [head.stdout.toString().trim()];
  if (head.status === 1) return ["--cached"];
  throw new Error(head.stderr.toString().trim() || "Could not resolve Git HEAD");
}

function readChanges(revision, staged, paths) {
  const tracked = ["--cached", ...(staged ? [] : ["--others", "--exclude-standard"])];
  const selected = paths.length
    ? new Set(nullFields(git("ls-files", "-z", ...tracked, "--", ...paths)))
    : null;
  const entries = nullFields(
    git(
      "diff",
      "--raw",
      "-z",
      "--no-abbrev",
      "--no-ext-diff",
      "--find-renames",
      "--diff-filter=ACMRT",
      ...revision,
      "--",
    ),
  );
  const files = new Map();
  for (let index = 0; index < entries.length;) {
    const [oldMode, newMode, previous, next, status] = entries[index++].slice(1).split(" ");
    let file = entries[index++];
    if (status.startsWith("R") || status.startsWith("C")) file = entries[index++];
    if (regular(newMode) && codeFile.test(file) && (!selected || selected.has(file))) {
      files.set(file, { previous: regular(oldMode) ? previous : null, next });
    }
  }
  if (!staged) {
    for (const file of nullFields(
      git("ls-files", "-z", "--others", "--exclude-standard", "--", ...paths),
    )) {
      if (codeFile.test(file) && !files.has(file)) files.set(file, { previous: null });
    }
  }
  return files;
}

function readWorkingFile(file) {
  const path = join(root, file);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  return stat?.isFile() ? readFileSync(path) : null;
}

function replaceWorkingFile(file, source, formatted) {
  const path = join(root, file);
  const dir = mkdtempSync(join(dirname(path), ".omb-format-"));
  try {
    const replacement = join(dir, "replacement");
    writeFileSync(replacement, formatted);
    const current = readWorkingFile(file);
    if (!current?.equals(source))
      throw new Error(`${file} changed while being formatted. Run format:changes again.`);
    chmodSync(replacement, lstatSync(path).mode & 0o777);
    renameSync(replacement, path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function whitespaceIssues(revision, paths) {
  const result = spawnSync(
    "git",
    [
      "--literal-pathspecs",
      "diff",
      "--check",
      "--no-ext-diff",
      "--no-color",
      ...revision,
      "--",
      ...paths,
    ],
    gitOptions,
  );
  if (result.error) throw result.error;
  if (result.status === 0) return "";
  if (result.status === 2) return result.stdout.toString().trimEnd();
  throw new Error(result.stderr.toString().trim() || "Could not check Git whitespace");
}

async function inspectChanges(files, { staged, write }) {
  const updates = [];
  const snapshots = [];
  const findings = [];
  if (!files.size) return { updates, snapshots, findings };

  const { formatChangedStatements } = await import("./format-changed-statements.mjs");
  for (const [file, { previous, next }] of files) {
    const content = staged ? git("cat-file", "blob", next) : readWorkingFile(file);
    if (!content || content.includes(0)) continue;
    const source = decoder.decode(content);
    const before = previous ? decoder.decode(git("cat-file", "blob", previous)) : null;
    if (before === source) continue;

    try {
      const formatted = await formatChangedStatements(file, before, source);
      if (formatted.lines.length) {
        if (write) updates.push({ file, content, text: formatted.text });
        else
          findings.push(
            ...formatted.lines.map((line) => `${file}:${line}: format the changed statement`),
          );
      }
      if (!write) snapshots.push({ file, before, source });
    } catch (error) {
      const line = error.loc?.start?.line ?? 1;
      findings.push(`${file}:${line}: ${error.message.split("\n")[0]}`);
    }
  }
  return { updates, snapshots, findings };
}

async function main() {
  const { values, positionals: paths } = parseArgs({
    options: { staged: { type: "boolean" }, write: { type: "boolean" } },
    allowPositionals: true,
  });
  const { staged, write } = values;
  if (staged && write) throw new Error("--staged is available for check:changes only.");

  const revision = diffArgs(staged);
  const files = readChanges(revision, staged, paths);
  const whitespace = write ? "" : whitespaceIssues(revision, paths);
  const { updates, snapshots, findings } = await inspectChanges(files, values);
  const problems = [whitespace, ...findings].filter(Boolean);

  if (snapshots.length) {
    const { checkReadability } = await import("./check-changed-readability.mjs");
    problems.push(...checkReadability(snapshots));
  }
  if (problems.length) {
    console.error(problems.join("\n"));
    if (!write && findings.length)
      console.error(
        "For formatting findings, run pnpm format:changes -- <paths>, review the diff, and stage the intended edits again.",
      );
    process.exitCode = 1;
    return;
  }

  for (const { file, content, text } of updates) {
    replaceWorkingFile(file, content, text);
    console.log(`Formatted changed statements in ${file}`);
  }
  if (!updates.length)
    console.log(`Changes ${write ? "already formatted" : "passed"} (${files.size} code file(s)).`);
}

main().catch((error) => {
  console.error(`check:changes: ${error.message}`);
  if (error.code === "ERR_MODULE_NOT_FOUND" || error.code === "MODULE_NOT_FOUND") {
    console.error("Install the development dependencies with pnpm install.");
  }
  process.exitCode = 1;
});
