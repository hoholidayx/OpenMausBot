# Upstream synchronization log

This log records what the fork has reviewed and what it has adopted. The last
reviewed upstream tip sets the next review range. A reviewed commit can be
skipped or deferred, and the fork's `HEAD` and merge base can change independently.

For each review, fetch `upstream/main` and list the commits in
`<last-reviewed-upstream-tip>..<new-upstream-tip>`. Confirm the old tip is an
ancestor of the new one before using that range. If upstream rewrites its
history, compare the old and new upstream histories and document the revised
boundary. Review against the current fork and append the date, fork `HEAD`, both
upstream SHAs, the decisions, and the verification. Record the fork commit SHA
once an upstream change lands. Add later decisions for deferred changes to the
log even when their commits are outside the next range.

## 2026-11-17

| Review point | Commit |
| --- | --- |
| Previous upstream boundary | `12c07fb5fff3faa755233a71d25f034bbed7ae0f` |
| Last reviewed upstream tip | `57405b53a4b1ea384e978f472a5917714233d5c9` |
| Fork `main` reviewed | `63e7db04858ac9fae692cbd0ae96fa2aabb23322` |

This first entry covers 12 upstream commits after the last official merge. A
full merge preview produced 46 conflicting files, including 17 locale files.
The review uses the fork's self-hosted deployment, current sharing workflow,
default-off legacy memory, and Netlify access policy as its baseline. The two
changes selected for adoption are recorded below.

| Upstream change | Decision | Reason and evidence |
| --- | --- | --- |
| [`964f400bd`](https://github.com/milind-soni/OpenMausBot/commit/964f400bd) Release test fixes | Reference | Mixed platform and test fixes include cases for removed features. Use individual fixes when the corresponding failure exists on the fork. The Windows lease patch below applies independently. |
| [`3339b56b2`](https://github.com/milind-soni/OpenMausBot/commit/3339b56b2) Release 0.1.164 | Skip | Version and data-format metadata describe the official release. Set them as part of a fork release. |
| [`c18fe85e5`](https://github.com/milind-soni/OpenMausBot/commit/c18fe85e5) Windows data-directory lease | Recommend direct pick | A simulated Windows process probe reproduced the fork allowing a second owner when the live process's reported start time was slightly later than its lease timestamp. The isolated cherry-pick preview had no text conflicts and passed 44 lease tests, with 5 platform-related skips on macOS. Native Windows verification is pending. |
| [`0bf450c39`](https://github.com/milind-soni/OpenMausBot/commit/0bf450c39) Release 0.1.165 | Skip | Official version and data-format metadata follow the official release. |
| [`49968d7f1`](https://github.com/milind-soni/OpenMausBot/commit/49968d7f1) Cloud invitations and seats | Skip | Depends on the hosted Cloud account and admin portal removed from this fork. |
| [`05948b876`](https://github.com/milind-soni/OpenMausBot/commit/05948b876) Share templates and import | Defer | Single-bot templates and local folder or GitHub import could be useful. The fork already supports department packages, and the upstream change replaces existing export entry points and adds optional hosted publishing. Its standalone preview conflicts in 12 files. Revisit when single-bot sharing or GitHub import is needed. Preserve old JSON entry points and test Web import and export in any local adaptation. |
| [`200de1b80`](https://github.com/milind-soni/OpenMausBot/commit/200de1b80) Netlify public by default | Skip | The upstream skill can remove a site's login protection on a production publish or republish. The fork requires an explicit action to open a protected site. |
| [`92cedf056`](https://github.com/milind-soni/OpenMausBot/commit/92cedf056) JSON registry abstraction | Defer | Still writes the existing JSON files and overlaps the fork's store. Revisit for a measured persistence bottleneck or a planned storage change. Verify existing-data reads, write failures, and recovery in an isolated fixture. |
| [`528e787c8`](https://github.com/milind-soni/OpenMausBot/commit/528e787c8) Published-site preview cards | Reference | The fork already lists published sites. Revisit if in-chat previews become a requirement, and check the framing policy for the fork's allowed site origins. |
| [`d43b36ccb`](https://github.com/milind-soni/OpenMausBot/commit/d43b36ccb) Settings paths and validation | Recommend local adaptation | Current voice and live-call hints still point to `Settings → API keys` or just `Settings → AI`, while the fork's settings map places those keys under `Settings → AI → Other services`. Fix the affected fork copy and guard against stale paths. The upstream patch also changes many unrelated locale strings. |
| [`b945b7b98`](https://github.com/milind-soni/OpenMausBot/commit/b945b7b98) Claude tool deferral and prompt size | Defer | Measure request size and tool discovery on the fork first. If worthwhile, adapt deferral and the shorter Data guide while testing tool mounting and selection. |
| [`57405b53a`](https://github.com/milind-soni/OpenMausBot/commit/57405b53a) Shorter built-in and memory prompts | Defer | The memory prompt split has limited benefit with legacy memory off by default. If a broader prompt optimization is needed, preserve the memory switch and conversation search and verify both memory modes. |

### Adopted changes

| Upstream | Fork commit | Verification |
| --- | --- | --- |
| `c18fe85e5` | `315e3cfe311df50ada16aed58ffd5738bbeabd35` | Cherry-picked with `-x`. The lease suite passed 44 tests on macOS, including simulated Windows process probes, with 5 platform-related skips. Routine spacing and file-size checks passed. Native Windows verification is pending. |
| `d43b36ccb` | `3277383c6f37d3316219a112f8eda69b46c6ce9c` | Adapted the affected live-call and readout key directions to the fork's settings map and localized menu labels. The settings and call UI checks passed 134 tests. The supported server and companion checks passed 268 tests, including the isolated missing-key response. |

The expanded run also covered older Cloud-related tests. Four Cloud-key UI
tests, three voice tests covering Cloud access or tokens, and one hosted voice
suite failed on both the updated code and the recorded fork baseline `63e7db048`.
