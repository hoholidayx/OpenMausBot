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

## 2026-11-20

| Review point | Commit |
| --- | --- |
| Previous upstream boundary (November 18) | `35d044295697ef2b79b889461af6902c85a1b456` |
| Last reviewed upstream tip | `a90bf36551c257b09ab326ba228cc796f5d4fdd1` |
| Fork `main` reviewed | `3b43891d2c563452e3da03e478d1324307f2b728` |

Fetched the official `main` and confirmed the remote `HEAD` at 23:52 China Standard Time (UTC+8). The previous boundary is an ancestor. The range contains 469 reachable commits, 61 on the first-parent chain, 314 non-merge commits and a net diff of 974 paths. We screened the commit subjects and examined the affected fork paths for the candidates below. The picks and adaptations were exercised in disposable checkouts. This entry records recommendations for the single-user fork. [Official range](https://github.com/milind-soni/OpenMausBot/compare/35d044295697ef2b79b889461af6902c85a1b456...a90bf36551c257b09ab326ba228cc796f5d4fdd1)

### Recommended picks

| Workflow | Upstream commits in pick order | Evidence on this fork |
| --- | --- | --- |
| Delegated work reaches completion | [`27333c386`](https://github.com/milind-soni/OpenMausBot/commit/27333c38660924329efb397c0bed43f572e3a5e5), [`2d8ef3312`](https://github.com/milind-soni/OpenMausBot/commit/2d8ef3312e526150f08cde9779071c898b8638c8) | `NEEDS INPUT: 无` parked a completed assignment. The pair distinguishes a real question from a whole-line “none” and preserves a question followed by a `Default:` line when handing the result back. The multilingual fix covers the earlier English-only [`8d8f304e0`](https://github.com/milind-soni/OpenMausBot/commit/8d8f304e0fe3bf113e4d25823e44eac57137f6de). |
| Questions copied from a routine | [`298bbc1c8`](https://github.com/milind-soni/OpenMausBot/commit/298bbc1c83f7f2a31db3a4cca34ead92118577bf) | Answering, dismissing or expiring the original could leave its copy in the main chat asking for attention. All three cases failed on the fork. The preview also resumed the run from its copy in a real fixture server. |
| Downloadable hand-off attachments | [`0379ca060`](https://github.com/milind-soni/OpenMausBot/commit/0379ca0603a1f132331503e350f11d2b32518ab2), [`4881327aa`](https://github.com/milind-soni/OpenMausBot/commit/4881327aa17c21d7be0b2d0ed758972ef69a8897), [`213ccc236`](https://github.com/milind-soni/OpenMausBot/commit/213ccc236c53987f1a5e77e6c90431b19c8826e9). Independently, [`842a1f8b1`](https://github.com/milind-soni/OpenMausBot/commit/842a1f8b16f86add78855b6d250cf2986b70eb1c) | The real fixture returned HTTP 403 for a result card’s own attachment. The three commits together return its bytes and apply the route’s existing conversation-visibility rules. The independent filename fix preserves literal characters when attaching a file from the host or a mounted guest workspace. |
| OpenCode quota attribution | [`2f22a2b6b`](https://github.com/milind-soni/OpenMausBot/commit/2f22a2b6be7d2b3177efeb7ee694096cfd9e7af1) | When the saved model had left the catalog, the fork could hold the retired ID and leave the model the ACP session actually used available. The fake OpenCode driver reproduced it. The preview covers both single and shared free allowances and leaves the unrelated paid model available. The patch applies with a three-way cherry-pick to the fork’s existing engine pin. |
| Chinese input and translated settings | [`c517e27cd`](https://github.com/milind-soni/OpenMausBot/commit/c517e27cd408c20cb6cb736e927d851e81474d18), [`ebb9089c6`](https://github.com/milind-soni/OpenMausBot/commit/ebb9089c6e30f22ea6ebdeecd58e7fa228d43cb5) for the composer. [`00c436dae`](https://github.com/milind-soni/OpenMausBot/commit/00c436dae202b273540274eb7253aff32b9636d3) and [`779ac78e9`](https://github.com/milind-soni/OpenMausBot/commit/779ac78e9561979f46e31e1a86444f7b647cc0a3) independently | The mention overlay hid native composition feedback. In Settings, Enter to confirm a character could save a partial computer name. The fork’s MCP panel also threw when the list arrived after a page translator had replaced its loading text. Each regression passed in the preview, including the panel in both display modes. |

### Recommended local adaptations

| Workflow | Upstream reference | Smallest verified change |
| --- | --- | --- |
| Web startup | [`2dedbf5ff`](https://github.com/milind-soni/OpenMausBot/commit/2dedbf5ffdf5cbb790c42931e53bbc9bf88e157d) | Extract `browserMatesOf` from `shared/logins.ts` and import it directly in the sign-in card. This three-file slice keeps the public-suffix library off the initial chat loading path. Five files conflicted in a trial pick of the entire commit, including the sidebar and lazy-screen registry. The independent slice reduced the initial JS by 96,054 bytes, or 42,162 bytes with gzip. |
| Reading long chats | [`3824568a8`](https://github.com/milind-soni/OpenMausBot/commit/3824568a84cf03ca02636d11af935113946c21e5), [`e5b9ae8f9`](https://github.com/milind-soni/OpenMausBot/commit/e5b9ae8f9b95fa9cebc0d88c57b29446a045c407), [`f7b4ff145`](https://github.com/milind-soni/OpenMausBot/commit/f7b4ff14508275ba4b0340b2fd614dca4e225188) | Apply the window-size cap, adapt selection preservation to the fork’s viewport hook, then pick the scroll-anchor fix. In the middle patch, import `startTransition` and omit the two guards for staged first paint from [`96acdd4bc`](https://github.com/milind-soni/OpenMausBot/commit/96acdd4bcd14b702288fcca25baf414f469cd4c1). In a 3,000-row fixture the fork’s window grew to 3,000 while paging back. The preview returned at most 240 ordinary rows, in steps of 20. Its viewport tests cover selection, focus jumps and anchor restoration. Before landing, check scrolling across this fork’s asynchronous image and partner cards on a phone. |
| MCP servers with dynamically registered credentials | [`96c93df80`](https://github.com/milind-soni/OpenMausBot/commit/96c93df80f8efe9f785f3b6f3be4baf762063813) | The fork can discard a client secret an MCP server issues at sign-in. Both loopback OAuth cases failed on the fork. Keep its existing registration-error message when resolving `server/mcp-oauth.ts`, and carry the issued credentials through sign-in, refresh and sign-out. |
| Repeatable fixture boot | [`1a7c4a16d`](https://github.com/milind-soni/OpenMausBot/commit/1a7c4a16d3a576317ff2cdad5aa925fda13267e8) | Set `OMB_DISABLE_MODEL_MANIFEST_FETCH=1` in the environment built by `verificationServerEnvironment` and take its regression test. This gives independent fixture processes the same bundled catalog as Vitest. The fork omits the Cloud bulk-send test in the same commit. |

### Deferred and skipped

| Upstream area | Decision and condition for revisiting |
| --- | --- |
| Core memory and Dream ([`78dc0d23d`](https://github.com/milind-soni/OpenMausBot/commit/78dc0d23d5e7c1f914bc87989f7dcdcc3811a42d), [`d6da38d17`](https://github.com/milind-soni/OpenMausBot/commit/d6da38d1764586ae896e7af0ed85ffc0fe28d5a0), [`827ba816a`](https://github.com/milind-soni/OpenMausBot/commit/827ba816aa07feddb9e42fcf35b1b5b64950862d), [`d734dfb85`](https://github.com/milind-soni/OpenMausBot/commit/d734dfb857b58f5a899fd81f27f5c35c189ec86d)) | Skip the legacy upkeep, forget and eviction paths. The fork parses CRLF and multiline entries in `server/core-memory.ts`, enforces entry and byte caps on edits, and passes an abort signal through the Dream writer. The fork’s core-memory, Dream history and tool suites passed. Revisit a specific failing input in these paths if one appears. |
| OpenCode lifecycle and engine resource limits ([`c29e9bf51`](https://github.com/milind-soni/OpenMausBot/commit/c29e9bf51122391fab64da362f2e9bbc3930a895), [`3167b9fa9`](https://github.com/milind-soni/OpenMausBot/commit/3167b9fa9087c050a041fc37c9269ade98474d9e), [`0792adcc7`](https://github.com/milind-soni/OpenMausBot/commit/0792adcc7171d08452bb7dc63791419700b052ba)) | The fork pins OpenCode 2.2.5. The 2.3.2 change also forks and deletes sessions to stop background jobs. Validate Stop, resumed history and a real bot’s configured model in an isolated installation before changing the pin. Independently, an isolated timer probe on the fork called `close` once after `idle()` turned false. A narrow busy-timer guard merits adaptation. The full pool cap, stall accounting and data-directory changes span different subsystems. Revisit the cap with a measured idle-process count. |
| Recovery, repeat work and hand-off status ([`9c0e7438b`](https://github.com/milind-soni/OpenMausBot/commit/9c0e7438b5f3e8bda32fc1779fb8ccb5e463ee65), [`b806f7f73`](https://github.com/milind-soni/OpenMausBot/commit/b806f7f73126d815ce36cad8d192134782fbd5d9), [`dd5c2ad5e`](https://github.com/milind-soni/OpenMausBot/commit/dd5c2ad5e7f33a1801cca826f1dc48238d1be5b5), [`449009bc0`](https://github.com/milind-soni/OpenMausBot/commit/449009bc044748483427ca28a4e4e48102243ec0), [`1d55de7af`](https://github.com/milind-soni/OpenMausBot/commit/1d55de7af95fea2290891b5002cd58b746680c68), [`f10d1832f`](https://github.com/milind-soni/OpenMausBot/commit/f10d1832f967063038604a806cdd3fa71b79af56), [`20aaf4f30`](https://github.com/milind-soni/OpenMausBot/commit/20aaf4f3095e46ba2fb7db701cec880d668a3800)) | The fork currently considers same-engine defaults and eligible plan engines after a limit. Restricting choices, changing room recovery or enabling bots to schedule a later turn changes dispatch policy. Revisit with an explicit preference. A separate refusal fix keys a result by run instead of thread. Adapt its `server/index.ts` wiring if two successive runs in the same conversation misattribute a refusal. Evaluate the optional hand-off indicators against existing partner status cards. |
| Server and rendering performance ([`9f7f7b1f3`](https://github.com/milind-soni/OpenMausBot/commit/9f7f7b1f3c8b00e954b231e7b3eff1714858e83b), [`585e6fcba`](https://github.com/milind-soni/OpenMausBot/commit/585e6fcbac01f25f068a72542767ffb4b9a67600), [`9d101a632`](https://github.com/milind-soni/OpenMausBot/commit/9d101a632dc35b4f53728880cc152aa32c7a7eb4), [`464175e29`](https://github.com/milind-soni/OpenMausBot/commit/464175e2970c1036cd26e18af5c54df1ba251ee2)) | The local ledger re-parses a month file on reads and `botByThread` scans bots. Measure a representative month and bot count before adding cache invalidation. Profile streaming on a fork-specific card or a long Apps list before pulling in the wider renderer changes. |
| Hosted and visual changes | Skip hosted checkout, pairing, release metadata and analytics. Wide-screen attachment previews ([`94837949b`](https://github.com/milind-soni/OpenMausBot/commit/94837949be287ac2dd9032ec237791a23a352e27)), sidebar navigation ([`2e836a99b`](https://github.com/milind-soni/OpenMausBot/commit/2e836a99bea9f387cfbd14b1f513d4c82c71c4d3)), mascot motion ([`336b1d8d2`](https://github.com/milind-soni/OpenMausBot/commit/336b1d8d2ccb3cbbdbae4442e363bf6e935d03b6)) and chat styling ([`613aff9d6`](https://github.com/milind-soni/OpenMausBot/commit/613aff9d6715cdb0ddbb968b7251b4f48abc6d81)) can be revisited for a specific workflow and checked against `DESIGN.md`. The last sidebar change ([`a90bf3655`](https://github.com/milind-soni/OpenMausBot/commit/a90bf36551c257b09ab326ba228cc796f5d4fdd1)) removes the pinned page tiles introduced earlier in the range. The fork already builds this tile grid from bots. The sign-in card placement was reverted upstream ([`d1829e524`](https://github.com/milind-soni/OpenMausBot/commit/d1829e5244b576d539381b861197b2ba15b3280a)). |

### Isolated verification

- Used disposable copies of the recorded fork commit, pnpm 10.33.0 and fixture homes. With the selected upstream regression tests on the original production code, 17 of 30 targeted cases failed. The functional preview passed 469 tests in 20 suites, plus the attachment-download test and two routine-answer cases on real, isolated servers. `pnpm typecheck` passed. OpenCode used a scripted ACP process and MCP OAuth used loopback providers.
- Exercised Chinese composition through Chromium’s IME protocol in the real chat composer at 390 and 1,280 CSS pixels, in both Midnight and Daylight. The native field showed the composing text, and the mention overlay resumed after committing the characters. Settings Enter and translated-panel transitions were checked in DOM tests.
- Built the original fork and the three-file startup adaptation with `pnpm exec vite build --manifest`. For the ordinary chat route, summed each JS chunk once from `index.html`, its boot-time `App` import and their static imports. Totals were 3,647,353 → 3,551,299 bytes and 1,108,604 → 1,066,442 bytes with per-file gzip at level 9. The login and sign-in-card suites passed all 58 tests. This measurement covers JavaScript size. Startup timing requires a separate browser measurement.
- The fixture launcher’s new bundled-catalog case failed on the fork and passed with the one-line adaptation. A separately launched HTTP fixture returned 200. With the added test, the launcher suite went from 8/10 to 9/10. Its remaining failure reproduced on both checkouts: `scripts/control-omb.ts` forwards `FAKE_CODEX_MODE` while the existing test expects it to be absent.
