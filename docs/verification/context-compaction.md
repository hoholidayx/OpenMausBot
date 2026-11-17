# Conversation context compaction

Long direct conversations can summarize older exchanges before the next turn.
The full transcript, its branches and attachments are retained. The new session
gets a bounded summary plus recent exchanges; later turns resume that session.
A visible, expandable note explains what was summarized, even with tool chips off;
when no model wrote the summary, it says the agent continues from recent excerpts only.

## Exercise the real path

```sh
pnpm exec vitest run server/context-compaction.e2e.test.ts
pnpm exec vitest run server/context-rebuild.test.ts server/compaction-summary.test.ts server/context-budget.test.ts server/delta-context.e2e.test.ts
pnpm exec vitest run server/side-jobs.test.ts server/helper-model.e2e.test.ts
pnpm exec vitest run server/store.test.ts server/config.test.ts src/components/DigestChip.test.ts
pnpm test:packaged-server
```

The API fixture launches the shared isolated server and fake engine. It uses
`control-omb` for create, send, wait, edit and Stop. Its new manual operation is
`POST /api/bots/:id/compact` with `{ "threadId": "owned-thread-id" }`; this uses
normal turn admission, returns 202, and completes through that thread's ordinary
busy/idle state. The route accepts no agent-written summary or file path.
From 80% of a known window, the bot's 1:1 header shows the figure with a
**Compact now** button that calls this route (hidden again once a compaction
record is newer than the last reply).

## Warm summaries: summarizing while the conversation is idle

Both kinds of compaction above run when the next turn starts, on the person's
time. On a Team trial every first answer slower than 35 s was Claude Code
summarizing a conversation of about 162k tokens at the start of the person's
turn (35 to 58 s, warm cache or not). A warm summary writes that summary in
the idle gap after the turn before, while the prompt cache is still warm, so
the next turn starts small.

- **When:** a direct conversation (not a room or a routine's run) whose turn
  ended with 100k tokens or more of context gets one about 3 minutes later. A
  conversation at 80% or more of where Claude Code summarizes by itself
  (`OMB_CLAUDE_AUTOCOMPACT`, 200,000 by default) gets one about 10 seconds
  later, because its next turn would summarize anyway. For other engines,
  OpenMausBot's own fold runs while idle once the conversation is at 85% of
  the threshold its next turn would fold at.
- **Claude Code:** `/compact` with instructions to keep the person's latest
  requests and every open question (open question cards are named), on a
  fork of the session (`--resume <session> --fork-session`) launched with
  the live process's exact contract, as the keep-warm ping is. It therefore
  reads the cached prompt start and keeps the conversation's tool list. No
  tool can run in it, and the engine hooks never hear it. When it finishes,
  the conversation moves to the fork: the old process is closed, and the
  next turn resumes the fork.
- **Word for word:** the person's last two messages and everything since
  count as not yet seen by the new session. The next turn sends them on the
  existing "not seen yet" path, which is saved with the conversation.
- **Shown in the chat:** the line "summarized this conversation while it was
  idle; the latest messages carry on word for word", in the language of the
  conversation's person (`server.warmSummary.summarized`). OpenMausBot's fold
  shows its usual summary note instead.
- **A turn that starts meanwhile wins:** the summary is abandoned and nothing
  changes. The exception is a turn that would summarize at its start anyway,
  which waits (up to 3 minutes) for the summary already being written rather
  than writing a second one.
- **Skipped while work is due:**
  - a message waiting in the queue;
  - a teammate working on this conversation's request, or one whose answer
    it awaits;
  - a wait that fired and will carry on here;
  - the workspace's spend limit reached.

  It is retried, every 2 minutes for up to 50 minutes after the turn (the
  cache's life), while the bot is busy, memory is short, or one of the bot's
  routines is due.
- **Opening the conversation:** the app's presence ping names the chat that
  is open. That starts a summary the next turn needs right away, and keeps
  the conversation's engine process alive for 10 minutes past the person's
  last activity.
- **Turning it off:** `context.autoCompact: false` turns warm summaries off
  with the rest of automatic compaction; `OMB_WARM_SUMMARY=0` turns off only
  warm summaries. The summary's model call is booked to the bot like a
  keep-warm ping.

```sh
pnpm exec vitest run server/warm-summary.e2e.test.ts
pnpm exec vitest run server/warm-summary.test.ts server/host/warm-summary-host.test.ts server/drivers/claude-warm-summary.test.ts server/thread-presence.test.ts server/routes/presence.test.ts
```

The fixture runs the real server with the fake Claude Code:

- the conversation grows 20k tokens a turn from 110k;
- Claude Code's own compaction fires at 162k and takes 6 s (standing in for
  35 to 58 s);
- warm summaries run at 1/100 of their delays (`OMB_WARM_SUMMARY_TIME_SCALE`).

It proves:

| Case | Time to the next reply |
|---|---|
| Off: the turn waits for the CLI's compaction | about 6.2 s |
| On: the conversation was summarized while idle | about 0.3 s |
| A message sent while the summary it needs is written | about 5.4 s (the rest of that summary, not a second one) |
| A message sent during a summary it did not need | under 0.5 s; the fork is dropped |

It also proves:

- the summary ran on a persisted fork with `/compact`, and the next turn
  resumed that fork;
- the last two exchanges reached the engine word for word, and the first did
  not.

The times are kept in
`<tmp>/openmausbot-verification-evidence/warm-summary-timings.jsonl`. No live
model runs: whether a real Claude Code honours `--fork-session` for
`/compact` in print mode is checked only by the fake.

## Rooms

A room keeps one confirmed native session per thread and member. ACP, Codex
and Claude Code with strict resume and engine hooks can continue from their
own cursors. When two members alternate on one engine, the driver can
replace its warm process. The returning member loads its own session and
receives the visible messages added since its last confirmed turn. Its own
previous replies stay in the native history. Speaker attribution, quotes,
attachments and pending handoff results travel with the relevant input.

A fresh session receives recent original messages, with at most 30 historical
entries and the `context.rebuildBytes` history budget. The default is 24,000
bytes. The current request and required references are included separately.
If the unread history exceeds the budget, the member starts a fresh session
with this bounded window. A missing native session can be rebuilt once
before the current input has reached the provider. Stateless engines receive
the bounded history by role. Older configurations may still contain the
retired `context.roomSessions` setting. All rooms use the same sender.

SQLite stores the private cursor, acknowledged message boundary and
fingerprints. Dispatch consumes the previous record. A normally completed
turn saves the next one. If a process dies during a turn, the next turn has
no committed receipt for that member and rebuilds from the active branch.
The host checks a reported session ID against both the saved receipts and
other turns still using that provider instance. An ordinary server restart
can resume a confirmed session. A workspace backup carries the conversation
records and a restore starts fresh provider sessions from that history.

### Room compaction

Each member's latest valid reading feeds `memberContext` and its own **Compact
now** action. The existing manual request and `context.roomCompactAt`
(default 0.9) reset that member before its next turn. Set
`context.autoCompact: false` to disable the threshold. A Claude Code native
compaction notification also invalidates that member's receipt. The next
turn starts with the bounded original history.

### Checks

```sh
corepack pnpm exec vitest run server/room-sessions.e2e.test.ts server/room-native-sessions.e2e.test.ts server/room-context.e2e.test.ts
corepack pnpm exec vitest run server/host/room-sessions.test.ts server/host/room-transcript.test.ts server/room-context-settings.test.ts
corepack pnpm exec vitest run server/room-coordination.e2e.test.ts server/room-parallel-threads.e2e.test.ts server/workspace-backup.test.ts
```

The fixtures inspect the actual provider payload, the requested session ID
and the persisted receipt. They exercise consecutive turns, two members on
one engine, server restart, a crash after dispatch, a missing session,
membership changes, a fork and return to the original thread, Stop, a queued
manual reset and a room post arriving during the turn. The native fixtures also
search for the original text after these turns. Budget tests include long
Chinese text and required inputs outside the recent window. The ownership test
reports another thread's in-flight native session ID and verifies that the host
interrupts the second turn without recording a second owner. The backup check
verifies that the exported SQLite copy omits the cursor and a restore into the
original workspace starts with no room cursors.

An authenticated Codex `gpt-5.6-luna` probe used synthetic work text in a
disposable server with an independent Codex home. Editor resumed its
original session after Tester spoke. Tester resumed its own session after
the server restarted. Editor recalled the initial project colour and combined
it with Tester's new status. For this run the probe counted the UTF-8 text in
`turn/start` and read token figures from provider events. Latency runs from
`turn/start` to the first assistant text delta.

| Turn | Native action | User bytes | Input tokens reported | Cached read tokens | First text |
| --- | --- | ---: | ---: | ---: | ---: |
| Editor | Start | 3,687 | 15,627 | 9,984 | 6.13 s |
| Tester | Start | 3,957 | 15,702 | 9,984 | 4.71 s |
| Editor | Resume | 678 | 31,441 | 25,472 | 4.50 s |
| Tester after restart | Resume | 690 | 31,606 | 25,472 | 6.81 s |

## ACP agents' own readings

An ACP agent manages compaction in its own session. The 1:1 header still shows
the occupancy reported by `usage_update` (`used` and, when supplied, `size`).
The host skips pre-turn compaction and idle summaries for ACP and omits the
manual control. Both manual endpoints return `409 provider_managed_context`
for ACP. Switching a room member to ACP clears its prior host reading and any
queued manual reset.

Existing host summaries remain in the conversation history. An ACP turn can
resume its native session across those records. When that session is missing,
recovery uses the bounded original transcript and the current request.

```sh
pnpm exec vitest run server/acp-context-reports.e2e.test.ts server/host/warm-summary-host.test.ts src/lib/context-warning.test.ts
```

The fixture checks missing, near-empty and 95% occupancy reports against a low
host threshold. It captures the ACP session load and prompt to verify native
resume, then makes the native session unavailable and checks the new prompt
for original messages. The room fixture switches to ACP after queueing a host
reset for the previous engine.

Evidence covers:

- Automatic compaction keeps the two latest exchanges and the incoming request.
- A completed turn retains the driver's latest-prompt measurement, separately from summed input tokens.
- Claude compaction leaves headroom before the selected account's numeric native threshold, including after a previous compaction; `auto` and `off` do not invent a numeric native limit.
- Manual compaction executes no additional agent turn and retains the original messages.
- A repeated request at the same compacted tip is a no-op.
- Restart before the next send retains the summary and replaces the native session once.
- A later send keeps that replacement session instead of injecting the summary again.
- Editing an old message replays its selected branch, not the abandoned summary.
- Stop aborts a hanging summary call without a late record. A new send still works.
- Codex uses a local excerpt even when old settings name Claude as a fallback. A Claude conversation uses its own engine's one-shot summary.
- Private session bookkeeping stays off the task wire shape; stored summaries redact secrets.

Each API fixture retains exact requests, waits and bounded transcripts in
`<server-log>.context.json`, prints that location, and closes its exact child and
temporary home. No live account, computer or user workspace is touched.

## Tool history in a rebuilt session

A session rebuilt from the inline replay (an engine switched in mid-thread, a
rewind, a session the provider lost, a compaction) is sent what was said. With
`context.replayToolHistory: true` in config.json, or `OMB_REPLAY_TOOL_HISTORY=1`
in the server's environment (`0` forces it off), that replay also names each
earlier tool call on one line, between the two messages it ran between, as
`[ran: Bash: pnpm test — failed]` or `[ran: Read: server/config.ts — ok]`. It is
off by default, and off the replay is byte-for-byte what it was.

```sh
pnpm exec vitest run server/replay-tool-history.e2e.test.ts
pnpm exec vitest run server/context-rebuild.test.ts server/replay-settings.test.ts server/turn-context.test.ts server/config.test.ts
```

The fixture's engine runs a command and reads a file each turn. The test rewinds
with `control-omb edit` and reads the prompt the engine received: no such line
while the setting is off, both lines in order once it is on (the command, and
the file read), and the plain message for every turn that resumes its session.
It then switches the bot to the fixture's Codex and reads what that engine was
sent: the lines for each of Claude's turns. Its evidence is
`<server-log>.replay-tools.json`.

A line shows the tool, what it acted on and `ok`, `failed` or `no result
recorded`. What it acted on is the command beside the chip in the chat, or, for
a call whose chip shows none (a `Read`, a search), one argument from the input
preview behind the chip: the command, file, search pattern or query. A web
address is cut to its scheme and host (`https://hooks.example.com`), wherever it
is the whole target, so no path, query string or password in it is sent. An
input that is one plain string (a Codex web search's query) is used only when it
is a single line of at most 200 characters. Never a tool result, and nothing
else of the preview (a `Write`'s content, an `Edit`'s old and new text).

Each line is put on one line, redacted, cleared of anything that would open a
harness note (`escapeNotes` in `server/peer-provenance.ts`), then clipped to 120
characters; a long path keeps its end. At most 20 lines are sent, the most
recent, only for calls between the first and last replayed message, and only
from the bytes of `rebuildBytes` that messages left unused: the messages
selected are the same with the setting on or off. Engines that replay natively
(API models sent the transcript itself) and room turns are unchanged. A call is
still named without a target when its preview is arguments that hold none of
those at the top level. A URL inside a command is left as the command ran.

## Bounds and limitations

`context` settings in config.json are optional. `autoCompact: false` disables
automatic folding, `compactAt` is a fraction below 1 or a token count, and
`rebuildBytes` controls replay size (default 24,000 bytes). Context-only settings
do not reload provider processes. The default threshold is 80% of the known
model window; a real latest-prompt measurement wins over a transcript estimate,
except an ACP agent's own reading, which is shown and does not time compaction.
Summed input tokens across tool rounds are never treated as context size.
For Claude, the threshold and post-compaction regrowth floor also leave 10%
headroom below the selected account's numeric native-compaction setting.
That account's setting takes precedence over the inherited launch environment.
Native `auto`/`off` settings supply no known numeric bound; other engines keep
their own model-window threshold. The native CLI setting itself is unchanged.

The conversation's engine can write a summary if it supports a tool-free
one-shot call. It has a 20-second timeout. Summaries are capped at 6,000 bytes
and retain recent source corrections. The one-shot may incur provider usage
without a separate cost entry in the ledger.

The host falls back to a source-labelled excerpt when the call is unavailable
or fails. Pi and Muse Code lack a one-shot call. Codex and ACP engines keep their
agent-based background calls for eligible jobs such as skill review.
`server/helper-model.e2e.test.ts` boots an isolated server with fake Claude and
Codex engines and seeds retired configuration, environment and bot settings.
It inspects Claude's requests to confirm that the Codex excerpt required no
Claude call and the Claude conversation requested exactly one summary.

This slice covers direct threads. It does not add channel compaction, change
provider-native compaction, prove live-model summary quality, or ship native
iOS/Android compaction controls. The renderer test checks note markup and escaping,
not a real browser click. Native mobile indicators remain separate PR work.
