# Bot memory

## Read-only bot notes

Place a maintainer-approved `MEMORY.md` at
`<data directory>/bots/<botId>/MEMORY.md`. OpenMausBot reads it as reference
material for that bot's direct and room turns. The prompt preview shows the
same reference notes. Project and workspace rules and the bot's standing
instructions take precedence. The reader has a 200-line and 24,000-byte
prompt budget and skips expired dated entries.

Edit the file on the server as the maintainer. Put the bot's working folder
outside the notes directory and use a sandbox or operating-system permissions
to protect the notes from engines that can run local commands. The bot's
memory editor, writing tools, background learning and Markdown work logs
have been retired.

Previously saved `workspaces/<botId>/MEMORY.md`, topic files and daily logs
remain available as files. Review the old notes before copying any content into
the maintainer's file. Chats and tools still use the message database.
`session_search` searches accessible conversations and rooms.

## Private long-term memory with Mem0

Each enabled bot has one long-term partition across the owner's private conversations and paired owner devices. The NAS role uses `user_id = maus-<environment-id>` and `agent_id = <bot-id>`. A bot keeps its ID across renames, model changes and restarts. New and duplicated bots start with memory off.

1. In the bot panel, open **Bot settings → Apps it can use → Long-term memory**. In Advanced mode open **Access → Long-term memory**. Click the switch to see the deployment and bot IDs.
2. In the NAS Mem0 MCP service's private configuration, add one entry to `profiles` with those exact `user_id` and `agent_id` values, a fresh role `token`, and `allow_bulk_delete: false`. Omit `run_id`. Reload that service using its existing manager. Each enabled bot needs its own credential. Keep the Mem0 REST API key on the NAS.
3. Enter the service's HTTP(S) MCP address and the role token in the bot's settings. **Verify and turn on** checks the six tools, the expected identity, rejection of a different bot ID and absence of a session partition. Subsequent toggles use the saved role. To rotate the token at the same address, use **Change role credential**.
4. Ask the bot in a private chat to remember or look up something. The six tools appear on compatible models only for a turn initiated on a paired owner device or in the local desktop app. The bot's tool selection and approval settings apply. Deleting a single record requires an owner to approve its exact ID. Turning memory off cancels outstanding grants. Existing records stay on the NAS.

Rooms, delegated work, automation, Dots, external API turns, script tokens and chat-only pairings have no private memory grant. A plain reply makes no Mem0 request. No Skill is required. On a connection failure the bot can still chat. After a failed write, check the record before retrying.

### Switching from the shared connection

The commands below run from the repository on the Maus host. Substitute the actual data directory and the exact URL of the old shared `mem0` entry. Inspection can run while Maus is online. Switching and restoring take the same exclusive data-directory lease as the server. On a packaged desktop installation, quit the app first.

```sh
node scripts/bot-memory-legacy.ts inspect --data-dir "$HOME/.openmausbot" --endpoint http://nas:8889/mcp
./manage.py stop
node scripts/bot-memory-legacy.ts disable --data-dir "$HOME/.openmausbot" --endpoint http://nas:8889/mcp
./manage.py start
./manage.py status
```

The command matches a workspace-wide HTTP connection with a fixed bearer, verifies the NAS partition `maus-<environment-id>/workspace`, and saves the original entry and each bot's selection in `providers/mem0/legacy-workspace.json` (mode 0600). It changes only the entry's enabled flag. An unrelated service, an unverified role or a changed backup cannot be switched by name alone. Repeating the switch preserves the first backup. No per-bot role is enabled by the switch.

To roll back, turn off all private bot bindings, stop Maus, run the same command with `restore`, and start Maus. Restore checks the original endpoint, deployment, credential and explicit exclusions before applying the saved entry. Keep Pebble's explicit MCP selection empty if it was empty at cutover.

The old records remain in the NAS `workspace` partition. If the owner requests copies, record the specified source IDs and destination bot ID. Read each selected record with the old role outside a bot turn. Copy to the destination with a source ID in metadata, check by destination ID and content, and keep the mapping privately. On retry, look up the recorded ID or source metadata before adding a copy.

Per-bot credentials live in `providers/mem0/<environment-id>/bindings.json` (mode 0600). Workspace backups and bot exports omit these private files. Keep a separate protected copy for a same-deployment restore. Restore the original `environment-id` and bot registry together, then verify the role in the bot's settings. Another deployment starts unconfigured. To move the NAS to a new address, stop Maus, move the private bindings file into your protected backup, restart Maus and rebind each intended bot with its NAS role.
