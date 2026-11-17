# Read-only bot notes

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
