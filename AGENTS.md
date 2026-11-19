# OpenMausBot agent notes

Before claiming a server or conversation change works, follow
[`docs/verification/README.md`](docs/verification/README.md). Always launch an
isolated fixture; never verify mutations against the user's live app or data.

UI changes follow [`DESIGN.md`](DESIGN.md).

The [documentation index](docs/README.md) lists current guides and the upstream
archive. Keep active plans for this fork in [`docs/plans/`](docs/plans/).
When a plan's work and verification are complete, move it to
`docs/finished_plans/` and update the plans index and links to its new location.

## Upstream synchronization

Develop this fork independently. Base code and architecture decisions on its
own requirements, data, and operating environment. Use official upstream as a
reference for useful fixes, optimizations, and features.

Fetch upstream for review and adopt only selected changes by cherry-pick or
local adaptation. Keep upstream branch merges out of this fork. Review a
candidate's dependencies and validate it against this fork. Use
`git cherry-pick -x` for direct picks and record the upstream commit SHA in local
adaptations.

When a useful upstream change has substantial conflicts, first check the local
branch. Verify that the bug or bottleneck exists, or confirm the feature is needed
here. If the change is warranted, use the upstream implementation as a
reference and adapt it to the fork's architecture and intended behavior.

Include UI improvements in each upstream review. Assess the affected workflow,
accessibility, and fit with [`DESIGN.md`](DESIGN.md) on the fork's Web UI.

If adoption would materially change fork behavior or a safe adaptation is
unclear after the local review, pause and summarize the findings and tradeoffs
for the maintainer's decision.

Append each review to the [upstream synchronization log](docs/upstream-sync.md).
Use the last reviewed upstream SHA in that log as the starting point for the
next review. Record decisions for the reviewed range, including deferred
candidates and the evidence that would justify revisiting them.

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
- the rationale for a necessary invasive change or instrumentation;
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
