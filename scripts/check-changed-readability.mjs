import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import ts from "@typescript/typescript6";

const require = createRequire(import.meta.url);

function scopeName(source, offset) {
  const names = [];
  function visit(node) {
    if (offset < node.getStart(source) || offset >= node.end) return;
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) {
      const parent = node.parent;
      const name =
        node.name ??
        (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent)
          ? parent.name
          : undefined);
      names.push(name?.text ?? name?.getText(source) ?? ts.SyntaxKind[node.kind]);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return names;
}

function lintSnapshot(root, entries) {
  if (!entries.length) return new Map();
  const files = new Map(entries);
  for (const [file, text] of files) {
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }

  const manifest = require.resolve("oxlint/package.json");
  const bin = resolve(dirname(manifest), require(manifest).bin.oxlint);
  const run = spawnSync(
    process.execPath,
    [
      bin,
      "--allow",
      "all",
      "--deny",
      "complexity",
      "--deny",
      "max-depth",
      "--format",
      "json",
      "--",
      ...files.keys(),
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  if (run.error) throw run.error;
  if (run.status !== 0 && run.status !== 1)
    throw new Error(run.stderr.trim() || "Oxlint failed to check changed code");
  const { diagnostics } = JSON.parse(run.stdout);
  const groups = new Map();
  const parsed = new Map();
  for (const diagnostic of diagnostics) {
    const { code, filename, labels, message } = diagnostic;
    const file = relative(root, resolve(root, filename)).split(sep).join("/");
    const span = labels[0]?.span;
    const text = files.get(file);
    if (!span || text === undefined) throw new Error(`Oxlint: ${message}`);

    if (!parsed.has(file))
      parsed.set(file, ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true));
    const offset = Buffer.from(text).subarray(0, span.offset).toString().length;
    const scope = scopeName(parsed.get(file), offset);
    // Oxlint 1.80.0's JSON diagnostics include the measured value in the message.
    const score = Number(message.match(/(?:complexity of |nested too deeply \()(\d+)/)?.[1] ?? 1);
    const key = JSON.stringify([file, code, scope]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ score, report: `${file}:${span.line}:${span.column}: ${message}` });
  }
  return groups;
}

export function checkReadability(snapshots) {
  if (!snapshots.length) return [];
  const root = mkdtempSync(join(tmpdir(), "omb-readability-"));
  try {
    const before = lintSnapshot(
      join(root, "before"),
      snapshots.flatMap(({ file, before }) => (before === null ? [] : [[file, before]])),
    );
    const after = lintSnapshot(
      join(root, "after"),
      snapshots.map(({ file, source }) => [file, source]),
    );
    const findings = [];
    for (const [key, current] of after) {
      const previous = (before.get(key) ?? []).map(({ score }) => score).sort((a, b) => a - b);
      current.sort((a, b) => b.score - a.score);
      for (const { score, report } of current) {
        const match = previous.findIndex((oldScore) => oldScore >= score);
        if (match === -1) findings.push(report);
        else previous.splice(match, 1);
      }
    }
    return findings;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
