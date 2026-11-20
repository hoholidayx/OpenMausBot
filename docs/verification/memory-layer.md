# Verifying bot memory

## Dream and core memory

```sh
pnpm exec vitest run server/core-memory.test.ts server/dream-history.test.ts server/dream-tools.test.ts server/dream.e2e.test.ts server/read-only-memory.test.ts server/legacy-memory.e2e.test.ts server/memory-room-prompt.e2e.test.ts
pnpm exec vitest run scripts/testing/bot-memory-ui.e2e.test.ts
```

The Dream fixture uses **20 entries and 4,000 UTF-8 bytes**. The flag `OMB_TEST_CORE_MEMORY=1` takes effect only in the verification launcher’s sealed child. Unit cases also fill the **200-entry, 40,000-byte** production limits exactly. They count headings, list markers, newlines and multibyte characters, and check that the last entry reaches the prompt intact.

History tests cover deleting a conversation during and after a batch, importing an older conversation afterward, and distinguishing human messages from automatic handoffs.

The restartable server test interrupts the model after a tool has changed the file, starts the same fixture again, and checks that the cursor catches up without duplicating the edit. It checks a no-change batch, successful publication at capacity, stale edits, prompt preview, a fresh chat and zero Dream calls to the connected Mem0 fixture. A foreground turn on a second bot interrupts an active Dream. The browser test saves and restores the per-bot Dream criteria, exercises entry CRUD in Simple mode and makes an independent edit on a phone in Advanced mode. Server logs have sibling screenshots ending in `.core-memory-desktop.png` and `.core-memory-mobile.png`.

The legacy checks exercise direct and room injection, session search, symlinks and retired write endpoints. The supported file location and per-bot settings are in the [operating guide](../memory.md).

### DeepSeek replay, 2026-11-20

The isolated server used the Maus connection named `OpenCode2Api` and its selected model `deepseek-v4.1-flash`. A loopback relay forwarded provider traffic and recorded the tool names and arguments. The fixture carried two test bots and the smaller capacity limits. To repeat a live check, start `OMB_TEST_CORE_MEMORY=1 node --experimental-strip-types scripts/control-omb.ts launch`, configure the model on the printed fixture URL, and use that URL for every control command.

| Conversation | Observed result |
| --- | --- |
| The companion first learns a bedtime nickname, then hears a correction and later a withdrawal. | DeepSeek called `core_add`, `core_update` and `core_remove`. A fresh conversation between the correction and withdrawal answered “松果”. One revision included the superseded nickname in parentheses. |
| A temporary queue code applies only that day. | The batch completed with the previous file contents intact. |
| A dispatcher has its own rule about who reviews weekly reports. Its custom criteria restrict it to that topic. | It retained the reviewer 纸鹤 and skipped an unrelated drink preference. Restoring the default succeeded. Each Dream request advertised exactly the three entry tools. |

A separate live capacity run used test-only instructions to try the new entry first and recover if full. The real model received the capacity error, removed a specifically withdrawn entry, and retried the add. The entry-limited file went from 20 entries / 1,169 bytes to 20 / 1,103. The byte-limited file went from one entry / 4,000 bytes to one / 3,934. Both kept their handwritten prefix.

An early replay exposed a mismatch between the Markdown list marker and the complete old text a tool needs. Dream now receives a list of exact entry bodies plus the remaining handwritten prose. The unchanged-file and restart tests exercise the same tool contract as the live run.

### Optional prompt comparison

Two public samples ran on the same connection, in separate fixture bots. Both prompt versions started with empty notes. Only conversation roles, text, dates and session boundaries went into the replay. Reference answers were compared afterwards.

| Source and excerpt | Observed result |
| --- | --- |
| WildChat-1M, conversation `0175da830fe7e0e01f5624bb1ec26b89`, train row 65035. All three Chinese question/answer pairs discuss normalization and summary statistics. [Dataset](https://huggingface.co/datasets/allenai/WildChat-1M) | Both versions finished with zero core entries. |
| LongMemEval oracle, `59524333`, `knowledge-update`. Replay the user turn that mentions gym time and its following assistant reply from February 11 and May 30, 2023. Finish the February batch before supplying May. [Official data](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned) | The earlier prompt kept 7 pm and inferred a general meeting preference from one proposed slot. With the revised prompt, the model updated the existing gym entry to 6 pm and omitted that meeting preference. The reference answer is 6 pm. |

These examples record individual decisions for future prompt tuning. They carry no aggregate score or release threshold.

## Private Mem0 partitions

```sh
pnpm exec vitest run server/bot-memory.e2e.test.ts server/bot-memory-migration.e2e.test.ts
pnpm exec vitest run scripts/testing/bot-memory-ui.e2e.test.ts
```

The tests launch disposable Maus instances, an HTTP MCP service with a shared service credential and a deterministic API model. They configure the deployment once, enable two bots without further requests to Mem0 and check the partition headers. Two paired devices read the same bot’s records across threads. The second bot cannot get, update or delete the first bot’s record by ID. A plain chat makes zero Mem0 calls. The tests also cover clones, rooms, delegation, routines, external API turns, revocation during approval and rotation of the workspace credential.

The migration fixture tests the original workspace connection, an explicitly excluded bot, and an older per-bot role. It checks that the old role works until the shared connection is saved, both bot switches survive the change, and saved records survive restart and rollback. It also exercises missing credentials, a different deployment ID and an offline NAS.

The browser test connects the first bot, recovers from an incorrect credential, then enables a second bot with one switch on a phone-sized screen. It also opens the workspace connection editor. Server logs have sibling evidence files ending in `.bot-memory.json`, `.memory-migration.json`, `.memory-midnight.png` and `.memory-daylight.png`. See the [Mem0 operating guide](../memory.md#private-long-term-memory-with-mem0).
