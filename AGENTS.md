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

When merging an official upstream branch into this fork, review conflicts
against the merge base. Prefer preserving the fork's intentional changes and
incorporate compatible upstream changes where possible. Resolve conflicts at
the affected change so unrelated upstream work comes through.

If a conflict could have a major impact or the correct resolution is unclear,
pause the merge. Report the conflicting files, what each side changes, the
likely impact, and the available resolutions. Wait for the maintainer's
decision before resolving those conflicts or committing and pushing the merge.

## Local change checks

Use the pnpm version pinned in `package.json`. If the `pnpm` on `PATH` differs,
use `corepack pnpm` for these commands.

Review the diff and run checks relevant to the change. Keep the surrounding
code's style. `pnpm check:changes` is available on demand for whitespace,
nesting and complexity. `pnpm format:changes -- <paths>` explicitly formats
the selected changed statements.

`pnpm install` configures the repository's `pre-push` hook for lint, locale
and other repository checks.

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
