# Verify conversation context and compaction

Run these checks from the repository root with the pinned pnpm. The end-to-end tests launch disposable workspace homes and bind synthetic providers to loopback.

```sh
corepack pnpm exec vitest run server/conversation-compactor.test.ts server/context-compaction.e2e.test.ts server/acp-context-reports.e2e.test.ts
corepack pnpm exec vitest run server/drivers/openai-chat.test.ts server/turn-watchdog.test.ts server/room-turn-timeout.test.ts
corepack pnpm exec vitest run server/context-rebuild.test.ts server/delta-context.test.ts server/room-context.test.ts server/host/room-transcript.test.ts src/lib/context-warning.test.ts
corepack pnpm exec vitest run server/chief-rooms.e2e.test.ts
```

## API turns

Inspect the fixture requests as well as the transcript. The direct test performs three folds. Each successive request for a summary carries the previous summary and the newly covered portion of the branch. Recent source messages and the current request remain in the chat payload. Compaction rows exposed in the transcript carry a marker. Search returns the original, and Start fresh drops the active summary and earlier history from subsequent model requests.

The room test alternates bots, then compacts one member. Only that member receives the room summary. Check the roles, the newest user message, the responding bot's own maintainer notes, and the summary rows in the disposable database. The fixture also tests preflight with reported occupancy followed by a longer request on a provider turn that omitted usage.

For the waiting tests, the fixture holds an idle summary response while posting the next direct or room message. The send returns the stored message in its 202 receipt. The direct test also steers a follow-up into the waiting turn. After release, the provider receives one chat request with the summary and each input appears once, in order. During the next compaction, Stop closes the provider request and ends the turn. Compare the model requests, SQLite rows, and compaction markers before and after Stop.

The compactor tests advance a fake clock through background queueing and multiple batches, then verify the 180-second fallback against the previously saved summary. They also check the recent originals that reach the model when the saved summary exceeds the replay budget, a manual fold overlapping a small send, and the number of provider calls after a scope or history change between batches. The driver test verifies a summary call can outlast the ordinary provider idle timer. The watchdog and room tests exercise a 60-second silence limit through the wait and after release, including an unrelated approval event during a room's wait.

## Native agents

Attempt to add a native bot to a room and switch an existing API member to a native engine. Check the projected roster, the readable transcript, and the refusal to send in a room with no API members. The native Chief can use its management listing to change a bulletin in its department. Delegate from the API bot to the native bot using `coordinate_bots`. Check that its direct turn receives the explicit brief and selected file and that the result appears in the room. Compare the native prompt with a marker from the room's earlier transcript.

For a Codex compaction event, look for the engine compaction marker and two turns on one native thread. Manually calling the direct compact endpoint returns HTTP 409 with `provider_managed_context` for native engines. The ACP fixture also checks provider occupancy, resumed turns, and a cold rebuild from raw history.

On a machine with Codex CLI installed, the following probe exercises actual Codex app-server resume and compaction using a loopback model endpoint.

```sh
node scripts/verify-codex-instructions.mjs
```

The renderer test opens the new-room picker, then switches the last API member to a native engine and checks the add-API-bot hint.

```sh
corepack pnpm exec vitest run scripts/testing/control-omb-ui.e2e.test.ts -t 'offers API bots'
```

In an isolated app, open a native conversation with high reported occupancy and select **Compact now** to see the engine-managed explanation.
