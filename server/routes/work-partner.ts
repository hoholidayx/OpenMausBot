import { z } from "zod";
import type { BotRecord, Store } from "../store.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

const edit = z.object({ expected: z.string().nullable(), partnerId: z.string().min(1).nullable() }).strict();

interface Dependencies {
  store: Store;
  mayEdit(auth: RequestAuth, bot: BotRecord): boolean;
  retry(auth: RequestAuth, botId: string, threadId: string, rootId: string, attempt: number): boolean;
  candidates(auth: RequestAuth, bot: BotRecord): BotRecord[];
}

function binding(deps: Dependencies, auth: RequestAuth, bot: BotRecord, input: ReturnType<typeof edit.safeParse> | null) {
  const candidates = deps.candidates(auth, bot).filter(peer => peer.id !== bot.id && !peer.hidden);
  if (input) {
    if (!input.success) return { status: 400, body: { error: "Invalid work partner." } };
    const { partnerId, expected } = input.data;
    if ((bot.workPartnerIds?.[0] ?? null) !== expected) return { status: 409, body: { error: "Work partner changed. Reopen settings." } };
    if (partnerId && !candidates.some(peer => peer.id === partnerId)) return { status: 403, body: { error: "Work partner is unavailable." } };
    deps.store.patchBotProfile(bot.id, { workPartnerIds: partnerId ? [partnerId] : undefined });
  }
  return { status: 200, body: { partnerId: deps.store.bot(bot.id)?.workPartnerIds?.[0] ?? null, candidates: candidates.map(({ id, name, title }) => ({ id, name, title })) } };
}

export function workPartnerRoutes(deps: Dependencies): RouteHandler {
  return async ({ req, res, path, method, auth, readBody, json }) => {
    const retry = path.match(/^\/api\/bots\/([\w-]+)\/work-partner\/relay-retry$/);
    if (retry && method === "POST") {
      const input = z.object({ threadId: z.string(), rootId: z.string(), attempt: z.number().int().positive() }).strict().safeParse(await readBody(req));
      if (!input.success) return json(res, 400, { error: "Invalid relay." });
      const { threadId, rootId, attempt } = input.data;
      if (!deps.retry(auth, retry[1], threadId, rootId, attempt)) return json(res, 409, { error: "This relay is no longer available to retry." });
      return json(res, 202, { accepted: true });
    }
    const match = path.match(/^\/api\/bots\/([\w-]+)\/work-partner$/);
    if (!match || (method !== "GET" && method !== "PUT")) return PASS;
    const input = method === "PUT" ? edit.safeParse(await readBody(req)) : null;
    const bot = deps.store.bot(match[1]);
    if (!bot || !deps.mayEdit(auth, bot)) return json(res, 403, { error: "Bot settings access required." });
    const reply = binding(deps, auth, bot, input);
    return json(res, reply.status, reply.body);
  };
}
