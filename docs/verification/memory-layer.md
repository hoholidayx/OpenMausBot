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

The tests launch disposable Maus instances, a role-scoped HTTP MCP fixture, and a deterministic API model. They check the actual provider tool list and tool results for two paired devices, separate direct threads, two bots, a copy, a room, a delegated turn, a routine and an external API key acting as the owner. They check record-ID access, deletion at Full access, revocation during approval, and the absence of automatic NAS calls. The migration test restarts the same disposable workspace through cutover and rollback, with an inherited connection, an explicitly excluded bot, an old record, unavailable credentials, an offline NAS and a different deployment ID.

The browser test opens the real Simple and Advanced settings, binds a role after a failed credential check, toggles it off and on, and checks the mobile form. The server logs have sibling evidence files ending in `.bot-memory.json`, `.memory-migration.json`, `.memory-midnight.png` and `.memory-daylight.png`. See the [Mem0 operating guide](../memory.md#private-long-term-memory-with-mem0).
