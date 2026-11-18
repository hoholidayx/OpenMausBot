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

## 2026-11-18

| Review point | Commit |
| --- | --- |
| Previous upstream boundary | `57405b53a4b1ea384e978f472a5917714233d5c9` |
| Last reviewed upstream tip | `35d044295697ef2b79b889461af6902c85a1b456` |
| Fork `main` reviewed | `6fc122d6c30c23d2ded7cebb9347c1c98706664f` |

The previous boundary is an ancestor of this tip. The range adds 669 reachable
commits, with 36 first-parent nodes and 428 non-merge commits. The final tree
diff covers 949 paths. This review screened commit subjects across the range
and compared candidate patches with the fork's active paths. It uses
self-hosted Web deployment, API-only room members, host-owned API compaction,
read-only `MEMORY.md`, and manual export and backup as the baseline.
[Official range](https://github.com/milind-soni/OpenMausBot/compare/57405b53a4b1ea384e978f472a5917714233d5c9...35d044295697ef2b79b889461af6902c85a1b456)

### Recommended changes

| Upstream change | Decision | Reason and evidence |
| --- | --- | --- |
| [`9620d6b11`](https://github.com/milind-soni/OpenMausBot/commit/9620d6b11), [`8c77d7f38`](https://github.com/milind-soni/OpenMausBot/commit/8c77d7f38) Chat history paging | Adapt first | The fork loads the whole transcript on a cold `before` page. The upstream implementation reads one cursor page from SQLite and preserves unknown-cursor 404s, active leaf IDs, and legacy fallback. The isolated preview needed a small Store adaptation. The change covers backward paging. Search result windows and compaction history scans use separate paths. |
| [`eb74c5518`](https://github.com/milind-soni/OpenMausBot/commit/eb74c5518), [`3bfe8afc9`](https://github.com/milind-soni/OpenMausBot/commit/3bfe8afc9) Transcript cache eviction | Pick as a pair | Read-only use can leave the fork's transcript cache over budget after residency protection expires. The synthetic case remained at 40,260 bytes against a 25,000-byte budget. The preview retries eviction while preserving the requested and busy transcripts, with bounded retry frequency. |
| [`968037177`](https://github.com/milind-soni/OpenMausBot/commit/968037177), [`df6f7ecb5`](https://github.com/milind-soni/OpenMausBot/commit/df6f7ecb5) Recent-work lookup | Pick as a pair | The fork still ranks matching replies with a window query. The series uses indexed lookups per distinct thread and keeps one result per thread when IDs repeat. Query-plan tests passed with the paging preview. |
| [`5488e9fb7`](https://github.com/milind-soni/OpenMausBot/commit/5488e9fb7) API cached input accounting | Adapt first | Foreground API turns drop the provider's cache-hit count while the usage ledger and caps already consume that field. Seven new accounting cases failed on the fork and passed in the preview. Accumulate cache hits across rounds and use the last request for context occupancy. This supplies the measurement needed for the room cache-prefix work. |
| [`d66019cb7`](https://github.com/milind-soni/OpenMausBot/commit/d66019cb7), [`fc907088e`](https://github.com/milind-soni/OpenMausBot/commit/fc907088e), [`2e028f6aa`](https://github.com/milind-soni/OpenMausBot/commit/2e028f6aa) Manual exports | Pick the three changes | CLI `team export` writes YAML into a `.json` output today. Same-named linked folders can also collide on repeated exports. The tests confirm JSON round trips and preservation of retained files. Apply the two folder and file collision changes in order. |
| [`a2ff67acc`](https://github.com/milind-soni/OpenMausBot/commit/a2ff67acc), [`64a33b084`](https://github.com/milind-soni/OpenMausBot/commit/64a33b084), [`d608ddf70`](https://github.com/milind-soni/OpenMausBot/commit/d608ddf70) Local file and backup fixes | Pick individually | Overwrites can lose file mode bits under a restrictive umask. A backward clock adjustment can remove the rollback copy just created. The Data tool interprets some literal filenames as globs. The isolated preview passed each corresponding regression. |
| [`b0a8c1481`](https://github.com/milind-soni/OpenMausBot/commit/b0a8c1481), [`a12d5de95`](https://github.com/milind-soni/OpenMausBot/commit/a12d5de95) Stop and MCP configuration | Pick individually | An Ollama turn can stay busy after Stop while it awaits shared model preparation. A partial local MCP update can clear saved environment values. The preview releases the stopped turn, preserves the other turn's shared preparation, and rejects direct partial updates that would silently drop values. |
| [`64aadbd27`](https://github.com/milind-soni/OpenMausBot/commit/64aadbd27), [`83429990d`](https://github.com/milind-soni/OpenMausBot/commit/83429990d), [`2b38bbbf4`](https://github.com/milind-soni/OpenMausBot/commit/2b38bbbf4) API tool-call replay | Pick the normalization series | The tool runner rejects malformed arguments, and the next provider request can still contain the rejected argument string. Replay uses an empty JSON object for rejected input and keeps the tool-error result. The isolated OpenAI-compatible driver suite passed all 65 tests with this series. |

### Conditional and deferred changes

| Upstream change | Decision | Reason and evidence |
| --- | --- | --- |
| [`628307b1d`](https://github.com/milind-soni/OpenMausBot/commit/628307b1d), [`81706a6a0`](https://github.com/milind-soni/OpenMausBot/commit/81706a6a0) Local mail | Pick if the local mail tool is in use | Check turn lifetime before SMTP and preserve Bcc in the local Sent copy. Both apply and passed 13 tests with local fixtures. |
| [`50630c354`](https://github.com/milind-soni/OpenMausBot/commit/50630c354), [OAuth refresh series](https://github.com/milind-soni/OpenMausBot/pull/6466) | Pick the sign-in race fix if remote MCP OAuth is used. Defer the refresh series. | The sign-in race fix passed seven tests. The refresh series changes the credential store and interrupted-refresh behavior. Revisit with old-store, restart, and rotation tests using a local OAuth fixture. |
| [`b169141aa`](https://github.com/milind-soni/OpenMausBot/commit/b169141aa) Bot API report source | Pick if a report endpoint is configured | The fork defaults to no external report endpoint. The guard distinguishes automated API messages from user reports on configured installations. The isolated report suite passed 28 tests with a fake sender. |
| [`9a8359869`](https://github.com/milind-soni/OpenMausBot/commit/9a8359869), [`7779df662`](https://github.com/milind-soni/OpenMausBot/commit/7779df662) Start slow MCP servers in the background | Defer | Use the reworked series after the original version was reverted. The fork measures mounted tool definitions before API compaction. Measure tool startup time first, then check initial and late tool availability, permissions, and request size with an isolated delayed connector. |
| [`0dcd3904e`](https://github.com/milind-soni/OpenMausBot/commit/0dcd3904e), [`1310f7611`](https://github.com/milind-soni/OpenMausBot/commit/1310f7611), [`25254cde4`](https://github.com/milind-soni/OpenMausBot/commit/25254cde4) Conversation deltas and delegation | Reference | The fork already has separate API room history and native direct continuity. Revisit for a reproduced missing user line, wrong steer recipient, or repeated completed handoff. The upstream user-line change bypasses the soft budget. Check long unseen input and the fork's speaker and authority rules before adapting. |
| [`8ff26067d`](https://github.com/milind-soni/OpenMausBot/commit/8ff26067d) Background capacity after urgent jobs | Defer | The fork's production callers use ordinary slots. The upstream regression depends on urgent callers, including a warm-summary host absent from the fork. Revisit if a production caller needs urgent capacity. |
| [`bd7ecf5ba`](https://github.com/milind-soni/OpenMausBot/commit/bd7ecf5ba), [`ecdb29827`](https://github.com/milind-soni/OpenMausBot/commit/ecdb29827) Provider policy and reasoning options | Defer | The former changes cross-provider quota fallback and still allows certain same-provider defaults. The latter adds manual capability settings and changes provider request preparation. Treat each as a separate product decision. |
| [`0bbe6142f`](https://github.com/milind-soni/OpenMausBot/commit/0bbe6142f), [`0c885a280`](https://github.com/milind-soni/OpenMausBot/commit/0c885a280) Data doctor and process pressure | Reference | The doctor adds boot-time repair to deployment and touches registry and backup handling. A future manual repair workflow can reuse selected checks. Revisit the resource watchdog after measuring process pressure and stop behavior on the fork. |
| [`90c093d49`](https://github.com/milind-soni/OpenMausBot/commit/90c093d49), [`d6788b49c`](https://github.com/milind-soni/OpenMausBot/commit/d6788b49c), [`c18086673`](https://github.com/milind-soni/OpenMausBot/commit/c18086673) Room defaults, step cap, and title generation | Skip | Default parallel room jobs change dispatch ordering. Removing the step cap and making title generation unconditional add calls to the light-worker path. |
| [Release trains and product features](https://github.com/milind-soni/OpenMausBot/compare/57405b53a4b1ea384e978f472a5917714233d5c9...35d044295697ef2b79b889461af6902c85a1b456) | Skip this round | Official release metadata, hosted migration and billing, expanded team templates and vault integration, context panel redesign, and navigation changes are separate from these fixes. Use individual patches if the fork adds a corresponding requirement. |

### Isolated verification

Archived the recorded fork commit into disposable directories with isolated
test data. Ten small upstream commits and their regression tests passed
150 tests after applying in order. With the upstream tests alone, 27 tests
failed on the fork, covering cache eviction, export collisions, JSON output,
configuration rollback, literal paths, file modes, Stop, and MCP environment
updates. The history and indexed recent-work preview passed 39 tests. The
cached-usage preview passed 59 tests, including the fork's compactor tests.
The tool-replay, local mail, sign-in, and report-source preview passed
113 tests. These are preview results against the recorded fork, with adoption
decisions listed above.

### Adopted changes

The implementation was verified on top of fork commit
`87619fb4924122dab419f45440772cbc6333e7b6`.

| Upstream | Fork commit | Verification |
| --- | --- | --- |
| `9620d6b11`, `8c77d7f38` | `a6928e341a989d5dff3ab75e8931acb789f29a55` | Adapted to the fork's Store. The route tests cover cold latest and earlier pages, unknown cursors, legacy rows, the active branch, and a zero-message page. |
| `968037177`, `df6f7ecb5` | `635eb47845f3457b05ff79e4d232d7d3c58ce9a0`, `cecdf9c7f46d389deddf32d6f63df068734e01ea` | Picked in order. The database tests check the indexed query plan and repeated thread IDs. |
| `eb74c5518`, `3bfe8afc9` | `68b535b77f1e7f2eba63e2bf9b99ed75e7c7acf4`, `d231ac4d722606e0fbc8801615b571d045a67cd3` | Picked in order. The cache tests cover read-triggered eviction, busy and recently used threads, and the active leaf after reload. |
| `5488e9fb7` | `a489ad76a1579616e0cab5c7ea7630f8715fc0b9` | Adapted to the fork's API chat driver. Tests cover JSON, SSE, Responses, the usage ledger and caps, and compaction. |
| `d66019cb7`, `fc907088e`, `2e028f6aa` | `17512f87f1bedcc444f7dfdb41b5473f85e4f8ea`, `77c4f4cfd56d12205c211a330133861ba1122354`, `8bf59bf49d75938161d82e3709965385f9f62cbe` | Picked in order, with readability follow-up `09ded5e288e0c84605221c9d51049edac9d7bccf`. The real CLI exported valid JSON from an isolated server, and `team apply --check` reported `No changes.`. |
| `a2ff67acc`, `64a33b084`, `d608ddf70` | `1f4803fa3d13e8c035646a14788dfb88a354aa3c`, `15064ddc2a2aa8a9a722a7eb1008463c7dd11d83`, `7599cf2a69bd37ce273c50f9a2bc42be2f747c64` | Test fixtures cover file modes under umask, clock corrections during config rollback, and literal file and directory names. |
| `b0a8c1481`, `a12d5de95` | `711346ab03447bb8faa2b62dc94f7c1ae113df25`, `6a23dc660fd2bcb4874490807434f8ab44aa38d8` | Ollama preparation and local MCP configuration regression tests passed. |

The targeted run passed 387 tests in 22 files. The two CLI export suites
passed all 34 tests on rerun after the readability follow-up. Type checking,
lint, whitespace, and readability checks passed for the adoption range.
The extended isolated run passed 14 of 18 tests. The four failures also
occur on `87619fb49`. They are in `headless-cli.e2e.test.ts` and
`usage-caps.e2e.test.ts`, whose fixtures try to put native bots in API-only
rooms.
