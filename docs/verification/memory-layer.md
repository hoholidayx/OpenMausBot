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
