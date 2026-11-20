# Image generation

In private chat, an image can arrive while you continue the conversation.
Choose a dedicated MCP connection for background generation, or use the
configured image providers to attach an image when the bot finishes its reply.
The avatar editor uses the configured image providers.

## Background images in private chat

1. Open **Apps → MCP servers** in the sidebar. Add and enable the image server.
   For ComfyImageBridge, use its Streamable HTTP `/mcp` address as seen by the
   Maus host. If the server requires authentication, enter its MCP access
   credential in the connection. The image supplier's API key belongs with the
   service that calls the supplier.
2. Open **Settings → AI → Images** in Advanced mode and choose that connection under
   **Private chat images**. Maus checks the server's tool list when you select
   it. This check uses no image credit. The connection is reserved for image
   jobs. Bots with an explicit list of connections need this connection in
   their list, along with permission for the Images tool group.
3. Ask for a picture in a private bot conversation. A queued card appears
   under the request. You can send your next question, close the app, or open
   the same conversation on another paired device. The finished PNG appears
   on the original card and opens in the usual preview and download controls.

The host runs up to two concurrent MCP operations. It resumes jobs after a
restart, shares the installation's daily quota with synchronous chat images,
and checks the result's size, PNG structure, dimensions and SHA-256 before
delivery. A card awaiting confirmation can be checked again after automatic
retries pause. Checking a card looks up the same task. Revoking one device
removes its access while other authorized devices can still see the result.

ComfyImageBridge provides `image_submit`, `image_status` and `image_result`.
The bot receives `generate_image_async` in eligible private turns. Chat-only
devices may request an image in a visible conversation. Changing the
connection requires settings access. Selecting a dedicated connection makes the bot’s image tool available in
manually initiated private chats. Select **Use image providers below** to use
synchronous generation in chats and in replies to a person in a room. [Implementation and verification](verification/async-image-mcp.md)

## Synchronous image providers

Open **Settings → AI → Images** in Advanced mode. A link from the avatar
editor also opens it in Simple mode.

- **Base provider**: used first for every image.
- **Backup provider** (optional): used only when the base could not start.
- **Model** for each: a list with the recommended models first. For
  OpenRouter, the rest of the list is its live image catalog
  (`/api/v1/models?output_modalities=image`, fetched without a key and kept
  for an hour). When the catalog cannot be loaded, the page says so and shows
  only the recommended ones. **Other** opens a field to type any model ID.
  Custom has no list, so its model is always typed.
- **Images per reply**: the most images a bot may create in one turn (1–10,
  default 4). Images still being made count, so parallel calls cannot pass it.
  Images from Codex's own image tool count toward the same limit.
- **A day's images**: bots make at most 50 images a day on one installation,
  counted on disk so a restart does not reset it, starting again at local
  midnight. There is no setting for it. Avatars made in Settings are not
  counted.
- **Only for a person**: `generate_image` makes an image only in a turn a
  person's own message started (or work handed on from one). A routine, a
  webhook, an outside app or a guest's turn is refused with a line the bot
  can pass on, so nothing spends the image key unattended.
- **Keys**: each chosen provider gets a key field on this page. The Grok and
  OpenRouter fields save the same key as **API keys**. A key pasted into a
  model field is refused.
- **Test** (once a key is saved): checks the key with the provider and makes
  no image. For OpenRouter it also checks that the chosen model exists, and
  says when the account has no credit, since image models are paid. For the
  other providers the model is only checked when the first image is made.

With synchronous chat images selected, bots see `generate_image` when the
base or backup provider is configured.

| Provider | Key | Default model | Endpoint |
| --- | --- | --- | --- |
| OpenAI | its own, in this section | `gpt-image-2` | `api.openai.com/v1/images/generations` |
| Grok (xAI) | in this section; the same key as under **API keys** | `grok-imagine-image-2.0` | `api.x.ai/v1/images/generations` |
| Gemini | its own (Google AI Studio), in this section | `gemini-2.5-flash-image` | `generativelanguage.googleapis.com/v1beta/openai/images/generations` |
| OpenRouter | in this section; the same key as under **API keys** | `google/gemini-2.5-flash-image` | `openrouter.ai/api/v1/images` |
| Custom | optional, in this section | none: enter one | `<base URL>/images/generations` |

Each key goes only to its own provider; a missing key is never borrowed from
another one. Signing in to a ChatGPT, Claude, Gemini, Grok or Copilot
subscription does not give API access, so it does not configure any of these.
Bots on Codex can also use Codex's own image tool, which bills the ChatGPT
plan; it does not use these providers, but its images count toward
**Images per reply**.

## When the backup is used

The backup is tried only when the base confirmed that nothing started, the
same rule the text backups follow:

- the base has no key (or no URL and model, for Custom);
- the connection was refused or the host was not found;
- the base answered HTTP 401, 402, 403 or 429.

A timeout or an HTTP 5xx stays on the base, because the image may already have
been made and billed. A refused request (HTTP 400, including a moderation
block) also stays on the base: OpenMausBot does not retry a refused prompt
with another provider.

When the backup makes the image, the bot is told why the base did not, such as
`OpenAI image generation failed (HTTP 401, model gpt-image-2)`. When both fail,
the error names both reasons.

When the person names a provider ("make it with Grok"), the bot passes it and
only that provider is tried; it must be the base or the backup. When the base
and the backup are the same provider, naming it keeps the normal base-then-backup
order.

Synchronous generation stops if the turn or the engine's tool call ends before
the provider responds.

## Custom gateway compatibility

For a local gateway such as OmniRoute, a base URL might be
`http://127.0.0.1:20128/v1`. OpenMausBot appends `/images/generations`; pasting
that complete endpoint is also accepted. `localhost` and `127.0.0.1` refer to
the machine running the OpenMausBot server, including when you open the app
remotely. Public endpoints require HTTPS. HTTP is supported for local/private
endpoints. URLs must not contain embedded credentials, query parameters, or
fragments.

The gateway must accept a synchronous OpenAI-style Images API request with
`model`, `prompt`, `size`, `n: 1`, and `response_format: "b64_json"`. Its JSON
response must contain `data[0].b64_json` with raw base64-encoded PNG, JPEG, or
WebP bytes. Chat API compatibility alone is insufficient; URL-only responses,
redirects, and asynchronous job responses are not supported.

## Limits

Each decoded image is limited to 10 MiB. Synchronous providers have a 15 MiB
response limit and a two-minute generation timeout. Provider error bodies are never shown or stored:
an error names only the provider, the HTTP status and the model ID.
