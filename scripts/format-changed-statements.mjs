import ts from "@typescript/typescript6";
import { diffChars, diffLines, diffWordsWithSpace } from "diff";
import { format } from "prettier";

function changedSpans(before, after) {
  const spans = [];
  let offset = 0;
  let removed = "";
  for (const part of diffLines(before, after)) {
    if (part.removed) {
      removed = part.value;
      continue;
    }

    if (part.added) {
      const diffOptions = { maxEditLength: 2_048 };
      const chars = removed
        ? (diffChars(removed, part.value, diffOptions) ??
          diffWordsWithSpace(removed, part.value, diffOptions))
        : [part];
      let point = offset;
      for (const char of chars ?? []) {
        const end = char.removed ? point : point + char.value.length;
        if (char.added || char.removed) {
          spans.push({ start: point, end, atStatementEnd: char.removed && char.value === ";" });
        }
        point = end;
      }
    } else if (removed) {
      spans.push({ start: offset, end: offset });
    }
    removed = "";
    offset += part.value.length;
  }
  return spans;
}

function statementTree(source) {
  const statements = [];
  function visit(node, siblings) {
    if (
      (ts.isStatement(node) && !ts.isBlock(node)) ||
      ts.isClassElement(node) ||
      ts.isTypeElement(node)
    ) {
      const start = node.getStart(source);
      const lineStart = source.getPositionOfLineAndCharacter(
        source.getLineAndCharacterOfPosition(start).line,
        0,
      );
      const statement = {
        start: /^\s*$/.test(source.text.slice(lineStart, start)) ? lineStart : start,
        end: node.end,
        children: [],
      };
      siblings.push(statement);
      siblings = statement.children;
    }
    ts.forEachChild(node, (child) => visit(child, siblings));
  }
  visit(source, statements);
  return statements;
}

function touches({ start, end }, span) {
  if (span.start === span.end) {
    return start < span.start && (span.start < end || (span.atStatementEnd && span.start === end));
  }
  return start < span.end && span.start < end;
}

function untouchedChildren(statement, changes) {
  return statement.children.flatMap((child) =>
    changes.some((span) => touches(child, span)) ? untouchedChildren(child, changes) : [child],
  );
}

function preservesChildren(before, after, statement, changes) {
  const protectedChildren = untouchedChildren(statement, changes);
  if (!protectedChildren.length) return true;

  const parts = diffChars(before, after, { maxEditLength: 2_048 });
  if (!parts) return false;
  let start = statement.start;
  for (const part of parts) {
    const end = part.added ? start : start + part.value.length;
    if (
      (part.added || part.removed) &&
      protectedChildren.some((child) => touches(child, { start, end }))
    ) {
      return false;
    }
    start = end;
  }
  return true;
}

export async function formatChangedStatements(filepath, before, input) {
  const text = input.replaceAll("\r\n", "\n");
  const crlf = text !== input;
  if (crlf && /(?<!\r)\n/.test(input)) return { text: input, lines: [] };

  const options = { filepath, printWidth: 100, embeddedLanguageFormatting: "off" };
  const restore = (value) => (crlf ? value.replaceAll("\n", "\r\n") : value);
  if (before === null) {
    const formatted = restore(await format(text, options));
    return { text: formatted, lines: formatted === input ? [] : [1] };
  }

  const changes = changedSpans(before.replaceAll("\r\n", "\n"), text);
  if (!changes.length) return { text: input, lines: [] };

  const source = ts.createSourceFile(filepath, text, ts.ScriptTarget.Latest, true);
  const edits = [];
  async function visit(statement, enclosingChanges) {
    const matching = enclosingChanges.filter((span) => touches(statement, span));
    if (!matching.length) return;

    const { start, end, children } = statement;
    if (
      matching.some(
        (span) => !children.some((child) => child.start <= span.start && span.end <= child.end),
      )
    ) {
      const formatted = await format(text, { ...options, rangeStart: start, rangeEnd: end });
      const prefix = text.slice(0, start);
      const suffix = text.slice(end);
      if (
        formatted.startsWith(prefix) &&
        formatted.endsWith(suffix) &&
        formatted.length >= prefix.length + suffix.length
      ) {
        const beforeRange = text.slice(start, end);
        const afterRange = formatted.slice(start, formatted.length - suffix.length);
        if (
          beforeRange !== afterRange &&
          preservesChildren(beforeRange, afterRange, statement, matching)
        ) {
          edits.push({ start, end, replacement: afterRange });
          return;
        }
      }
    }

    for (const child of children) await visit(child, matching);
  }
  for (const statement of statementTree(source)) await visit(statement, changes);

  let formatted = text;
  const lines = edits.map(({ start }) => source.getLineAndCharacterOfPosition(start).line + 1);
  for (const { start, end, replacement } of edits.reverse()) {
    formatted = formatted.slice(0, start) + replacement + formatted.slice(end);
  }
  return { text: restore(formatted), lines: [...new Set(lines)] };
}
