import { MemoryRefusal, memoryChangeSchema, type BotMemory } from "../bot-memory.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

export function botMemoryRoutes(memory: BotMemory, owner: (auth: RequestAuth) => boolean, exists: (id: string) => boolean): RouteHandler {
  return async ({ method, path, auth, req, res, readBody, json }) => {
    const id = /^\/api\/bots\/([\w-]+)\/long-term-memory$/.exec(path)?.[1];
    if (!id) return PASS;
    res.setHeader("Cache-Control", "no-store");
    if (!owner(auth)) return json(res, 403, { error: "Only the local owner can configure bot memory." });
    if (!exists(id)) return json(res, 404, { error: "Unknown bot." });
    if (method === "GET") return json(res, 200, memory.status(id));
    if (method !== "PUT") return json(res, 405, { error: "Use GET or PUT." });
    const parsed = memoryChangeSchema.safeParse(await readBody(req));
    if (!parsed.success) return json(res, 400, { error: "Invalid memory settings." });
    try {
      return json(res, 200, await memory.change(id, parsed.data, () => owner(auth) && !res.destroyed));
    } catch (error) {
      if (error instanceof MemoryRefusal) return json(res, error.status, { error: error.message });
      throw error;
    }
  };
}
