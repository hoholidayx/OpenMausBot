import { PASS, type RouteHandler } from "./table.ts";
import type { RequestAuth } from "../request-auth.ts";
import { z } from "zod";
import { BOT_PROMPT_FIELDS, type BotModelPrefixSetting } from "../../shared/bot-prompts.ts";
import { BOT_PROFILE_LIMITS } from "../../shared/bot-profile.ts";
import { modelPrefixKey } from "../model-system-prefixes.ts";
import { readSoulDrift } from "../bot-folder.ts";
import { profileSnapshot } from "../profile-revision.ts";
import { recordProfileChange } from "../profile-versions.ts";
import type { BotRecord, Store } from "../store.ts";
import { botPromptSettings } from "../system-prompt.ts";

const textEdit = z.object({
  expected: z.string().nullable(),
  defaultText: z.string(),
  value: z.string().refine((s) => Buffer.byteLength(s) <= BOT_PROFILE_LIMITS.soul, "Prompt exceeds 24000 bytes").nullable(),
}).strict();

const promptEdit = textEdit.extend({ id: z.enum(BOT_PROMPT_FIELDS) });
const prefixEdit = textEdit.extend({ id: z.literal("model-system-prefix"), instanceId: z.string(), model: z.string() });
const editSchema = z.discriminatedUnion("id", [promptEdit, prefixEdit]);

function editBotPrefix(store: Store, bot: BotRecord, edit: z.infer<typeof prefixEdit>, current: BotModelPrefixSetting | null) {
  if (!current || current.instanceId !== edit.instanceId || current.model !== edit.model ||
    current.override !== edit.expected || current.defaultText !== edit.defaultText) {
    return { status: 409, error: "The model or its prefix changed. Reload to review the saved version." };
  }
  if (edit.value && !edit.value.trim()) return { status: 400, error: "Enter prefix text or turn the prefix off." };
  const overrides = { ...bot.modelPrefixOverrides };
  const key = modelPrefixKey(edit.instanceId, edit.model);
  if (edit.value === null) delete overrides[key];
  else overrides[key] = edit.value;
  store.patchBotProfile(bot.id, { modelPrefixOverrides: Object.keys(overrides).length ? overrides : undefined });
  return null;
}

function editBotPrompt(store: Store, bot: BotRecord, { id, expected, defaultText, value }: z.infer<typeof promptEdit>) {
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
  prefix: (bot: BotRecord) => BotModelPrefixSetting | null;
  mayEdit: (auth: RequestAuth, botId: string) => boolean;
  changed: (bot: BotRecord) => void;
}): RouteHandler {
  return async ({ req, res, path, method, auth, url, json, readBody }) => {
    const match = path.match(/^\/api\/bots\/([\w-]+)\/system-prompt$/);
    if (!match || (method !== "GET" && method !== "PUT")) return PASS;
    const edit = method === "PUT" ? await readBody(req) : null;
    const thread = url.searchParams.get("threadId");
    const bot = deps.store.bot(match[1]);
    if (!bot) return json(res, 404, { error: "no such bot" });
    const forPreview = () => thread ? deps.store.projectBotForTask(bot.id, thread) : bot;
    let previewBot = forPreview();
    if (!previewBot) return json(res, 404, { error: "no such conversation" });
    if (method === "PUT") {
      if (!deps.mayEdit(auth, bot.id)) return json(res, 403, { error: "Editing this bot’s prompts requires profile edit access." });
      const parsed = editSchema.safeParse(edit);
      if (!parsed.success) return json(res, 400, { error: parsed.error.issues[0].message });
      const problem = parsed.data.id === "model-system-prefix"
        ? editBotPrefix(deps.store, bot, parsed.data, deps.prefix(previewBot))
        : editBotPrompt(deps.store, bot, parsed.data);
      if (problem) return json(res, problem.status, { error: problem.error });
      deps.changed(bot);
      previewBot = forPreview()!;
    }
    const preview = deps.preview(previewBot);
    return json(res, 200, method === "PUT" || url.searchParams.get("editor") === "1"
      ? { ...preview, editable: botPromptSettings(bot), modelPrefix: deps.prefix(previewBot) } : preview);
  };
}
