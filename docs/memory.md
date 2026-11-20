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

Configure one Mem0 connection for the Maus deployment. Each bot has a **Long-term memory** switch under **Bot settings → Apps it can use**, or under **Access** in Advanced mode. New and duplicated bots start with the switch off.

1. On the first installation, open **Apps → MCP servers → Mem0** and enter the service's HTTP(S) MCP address and its `service_bearer`. You can also enter these when turning on the first bot. Maus checks the connection with a read-only probe. Saving it from Apps leaves every bot's switch as set.
2. Turn on **Long-term memory** for the bots you want. Maus selects each partition automatically using `X-Mem0-User-Id: maus-<environment-id>` and `X-Mem0-Agent-Id: <bot-id>`. The NAS uses the same service credential for all of them. Renaming a bot or changing its model, thread or owner device keeps its memories.
3. Ask the bot in a private chat to remember or look up something. Compatible models receive six Mem0 tools on turns from a paired owner device or the local desktop app. The bot's tool selection and approval settings apply. Deleting a record requires approval of its exact ID. Turning the switch off cancels pending calls and keeps saved records for later.

Maus performs no automatic recall or extraction. Ordinary chat makes no Mem0 request. No Skill is required. Rooms, delegated work, automation, Dots and external API turns do not receive these tools. If Mem0 goes offline, the chat remains available. After an interrupted write, check the record before retrying.

Use **Apps → MCP servers → Mem0 → Edit connection** to update the address or service credential for every enabled bot. Previously configured fixed per-bot roles keep working until the shared connection is saved. The change preserves bot choices and uses the same partition IDs. Keeping the same Mem0 data backend preserves the existing records.

### Switching from the shared connection

The commands below run from the repository on the Maus host. Substitute the actual data directory and the exact URL of the old shared `mem0` entry. Inspection can run while Maus is online. Switching and restoring take the same exclusive data-directory lease as the server. On a packaged desktop installation, quit the app first.

```sh
node scripts/bot-memory-legacy.ts inspect --data-dir "$HOME/.openmausbot" --endpoint http://nas:8889/mcp
./manage.py stop
node scripts/bot-memory-legacy.ts disable --data-dir "$HOME/.openmausbot" --endpoint http://nas:8889/mcp
./manage.py start
./manage.py status
```

The command matches a workspace-wide HTTP connection with a fixed bearer, verifies the NAS partition `maus-<environment-id>/workspace`, and saves the original entry and each bot's selection in `providers/mem0/legacy-workspace.json` (mode 0600). It changes only the entry's enabled flag. An unrelated service, an unverified role or a changed backup cannot be switched by name alone. Repeating the switch preserves the first backup. Each bot keeps its memory switch setting.

To roll back, turn off all private bot bindings, stop Maus, run the same command with `restore`, and start Maus. Restore checks the original endpoint, deployment, credential and explicit exclusions before applying the saved entry. Keep Pebble's explicit MCP selection empty if it was empty at cutover.

The old records remain in the NAS `workspace` partition. If the owner requests copies, record the specified source IDs and destination bot ID. Read each selected record with the old role outside a bot turn. Copy to the destination with a source ID in metadata, check by destination ID and content, and keep the mapping privately. On retry, look up the recorded ID or source metadata before adding a copy.

The connection and bot switches live in `providers/mem0/<environment-id>/bindings.json` (mode 0600). Workspace backups and bot exports omit this file. For a same-deployment restore, keep a separate protected copy and restore it with the original `environment-id` and bot registry. A different deployment starts unconfigured.
