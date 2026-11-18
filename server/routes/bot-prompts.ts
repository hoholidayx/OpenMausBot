import { PASS, type RouteHandler } from "./table.ts";
import type { RequestAuth } from "../request-auth.ts";
import { z } from "zod";
import { BOT_PROMPT_FIELDS } from "../../shared/bot-prompts.ts";
import { BOT_PROFILE_LIMITS } from "../../shared/bot-profile.ts";
import { readSoulDrift } from "../bot-folder.ts";
import { profileSnapshot } from "../profile-revision.ts";
import { recordProfileChange } from "../profile-versions.ts";
import type { BotRecord, Store } from "../store.ts";
import { botPromptSettings } from "../system-prompt.ts";

const editSchema = z.object({
  id: z.enum(BOT_PROMPT_FIELDS),
  expected: z.string().nullable(),
  defaultText: z.string(),
  value: z.string().refine((s) => Buffer.byteLength(s) <= BOT_PROFILE_LIMITS.soul, "Prompt exceeds 24000 bytes").nullable(),
}).strict();

function editBotPrompt(store: Store, bot: BotRecord, raw: unknown) {
  const parsed = editSchema.safeParse(raw);
  if (!parsed.success) return { status: 400, error: parsed.error.issues[0].message };
  const { id, expected, defaultText, value } = parsed.data;
  const current = botPromptSettings(bot).find((field) => field.id === id)!;
  if (current.override !== expected || current.defaultText !== defaultText) {
    return { status: 409, error: "This prompt changed. Reload to review the saved version." };
  }
  if (id === "soul") {
    if (readSoulDrift(bot.id, bot.soul ?? "", bot.soulHash ?? "").drift) {
      return { status: 409, error: "SOUL.md changed outside the app. Review the file in this bot’s standing instructions." };
    }
    const before = profileSnapshot(bot);
    store.setSoul(bot.id, value ?? "");
    recordProfileChange(bot.id, "user", "ui", before, profileSnapshot(bot));
  } else {
    const overrides = { ...bot.promptOverrides };
    if (value === null) delete overrides[id];
    else overrides[id] = value;
    store.patchBotProfile(bot.id, { promptOverrides: Object.keys(overrides).length ? overrides : undefined });
  }
  return null;
}

export function createBotPromptRoutes(deps: {
  store: Store;
  preview: (bot: BotRecord) => object;
  mayEdit: (auth: RequestAuth, botId: string) => boolean;
  changed: (bot: BotRecord) => void;
}): RouteHandler {
  return async ({ req, res, path, method, auth, url, json, readBody }) => {
    const match = path.match(/^\/api\/bots\/([\w-]+)\/system-prompt$/);
    if (!match || (method !== "GET" && method !== "PUT")) return PASS;
    const edit = method === "PUT" ? await readBody(req) : null;
    const bot = deps.store.bot(match[1]);
    if (!bot) return json(res, 404, { error: "no such bot" });
    if (method === "PUT") {
      if (!deps.mayEdit(auth, bot.id)) return json(res, 403, { error: "Editing this bot’s prompts requires profile edit access." });
      const problem = editBotPrompt(deps.store, bot, edit);
      if (problem) return json(res, problem.status, { error: problem.error });
      deps.changed(bot);
    }
    const preview = deps.preview(bot);
    return json(res, 200, method === "PUT" || url.searchParams.get("editor") === "1"
      ? { ...preview, editable: botPromptSettings(bot) } : preview);
  };
}
