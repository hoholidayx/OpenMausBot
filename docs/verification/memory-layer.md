# Verifying read-only bot notes

Run the read-only loader tests and the isolated server test with the fake Claude engine.

```sh
corepack pnpm exec vitest run server/read-only-memory.test.ts server/legacy-memory.e2e.test.ts
```

The server test verifies the prompts sent on direct and room turns, the prompt preview,
search of stored conversation messages, and the absence of the old memory write endpoint
and tool catalog entries. It also seeds retired notes, logs and a pending capture and
checks that the chat turns leave them untouched. The loader tests cover missing files,
expired entries, symlinks and UTF-8 limits.

See the [operating guide](../memory.md) for the file location and migration of existing notes.

## Private Mem0 partitions

```sh
pnpm exec vitest run server/bot-memory.e2e.test.ts server/bot-memory-migration.e2e.test.ts
pnpm exec vitest run scripts/testing/bot-memory-ui.e2e.test.ts
```

The tests launch disposable Maus instances, an HTTP MCP service with a shared service credential and a deterministic API model. They configure the deployment once, enable two bots without further requests to Mem0 and check the partition headers. Two paired devices read the same bot’s records across threads. The second bot cannot get, update or delete the first bot’s record by ID. A plain chat makes zero Mem0 calls. The tests also cover clones, rooms, delegation, routines, external API turns, revocation during approval and rotation of the workspace credential.

The migration fixture tests the original workspace connection, an explicitly excluded bot, and an older per-bot role. It checks that the old role works until the shared connection is saved, both bot switches survive the change, and saved records survive restart and rollback. It also exercises missing credentials, a different deployment ID and an offline NAS.

The browser test connects the first bot, recovers from an incorrect credential, then enables a second bot with one switch on a phone-sized screen. It also opens the workspace connection editor. Server logs have sibling evidence files ending in `.bot-memory.json`, `.memory-migration.json`, `.memory-midnight.png` and `.memory-daylight.png`. See the [Mem0 operating guide](../memory.md#private-long-term-memory-with-mem0).
