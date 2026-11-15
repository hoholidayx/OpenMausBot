# OpenMausBot agent notes

Before claiming a server or conversation change works, follow
[`docs/verification/README.md`](docs/verification/README.md). Always launch an
isolated fixture; never verify mutations against the user's live app or data.

UI changes follow [`DESIGN.md`](DESIGN.md).

## Upstream synchronization

For all code changes and architecture decisions, prefer loosely coupled,
minimally invasive designs so the project can continue incorporating changes
from the official upstream repository. Prefer existing extension points and
keep project-specific behavior in separate modules or adapters where practical.

When an invasive change or instrumentation is necessary, keep it localized.
Add a concise comment at the affected site explaining why it is needed and any
assumptions that matter when syncing with upstream.

## Local change checks

Use the pnpm version pinned in `package.json`. If the `pnpm` on `PATH` differs,
use `corepack pnpm` for these commands.

Run `pnpm check:changes` before handing off code changes. It checks working-tree
changes against `HEAD`, including untracked JavaScript and TypeScript files.
During a merge, rebase, cherry-pick, revert or unresolved conflict, the check
and formatter defer until the Git operation finishes or is aborted. Review any
conflict resolution separately: the check does not inspect already committed
changes after the operation.
Use `pnpm format:changes -- <paths>` for files in the task, then review the diff
and stage the intended edits. New files are formatted in full. Existing files
are formatted only where the formatter can isolate the changed statements.
The check also reports newly introduced or increased nesting and complexity.

`pnpm install` configures the repository Git hooks. `pre-commit` runs
`pnpm check:changes --staged` on the staged snapshot without modifying it.
Codex's project `Stop` hook runs the same working-tree check. Review and trust
the project hook in Codex before first use. Resolve findings within the current
task and report findings outside its scope.

## Comments

Write a comment only for what the code cannot say:

- a license or attribution notice;
- a fact forced by something outside this code (a vendor, CLI, OS, browser,
  Electron or protocol behaviour), with its version when it has one;
- the doc comment of a public contract: the wire types in `shared/`, the
  driver interface, the preload bridge, `config.json` fields people edit;
- the rationale and upstream assumptions for a necessary invasive change or
  instrumentation, as described above;
- a link to an upstream issue;
- a security invariant or a known open risk.

Do not narrate what the next line does, restate a name, record history ("used
to", "no longer", PR or issue numbers, plan or slice names: git has it), point
at other files, draw banners or leave commented-out code. When our own code
needs a paragraph to explain a surprise, change the code instead: a better
name, a type, an extracted function, one shared helper. A rule ("never X",
"must match Y") belongs in a type, a test or a lint rule. Never suppress a lint
rule that guards correctness; fix the code.

More specific `AGENTS.md` files override this note within their directories.
