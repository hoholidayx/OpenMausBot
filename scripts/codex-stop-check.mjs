import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const { stop_hook_active: continued } = JSON.parse(readFileSync(0, "utf8"));
const check = fileURLToPath(new URL("./check-changes.mjs", import.meta.url));
const result = spawnSync(process.execPath, [check], { encoding: "utf8", timeout: 45_000 });

if (result.status !== 0) {
  const findings =
    result.stderr?.trim() || result.error?.message || "check:changes did not complete.";
  const reason = `Local change checks failed.\n${findings}\nFix findings in the current task and rerun pnpm check:changes. Report findings outside the task's scope.`;
  const output = continued ? { systemMessage: reason } : { decision: "block", reason };
  console.log(JSON.stringify(output));
}
