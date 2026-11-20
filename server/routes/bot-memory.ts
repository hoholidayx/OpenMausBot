import { MEMORY_CONNECTION_PATH } from "../../shared/bot-memory.ts";
import { MemoryRefusal, memoryChangeSchema, memoryConnectionSchema, type BotMemory } from "../bot-memory.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

export function botMemoryRoutes(memory: BotMemory, owner: (auth: RequestAuth) => boolean, exists: (id: string) => boolean): RouteHandler {
  return async ({ method, path, auth, req, res, readBody, json }) => {
    const connection = path === MEMORY_CONNECTION_PATH;
    const id = /^\/api\/bots\/([\w-]+)\/long-term-memory$/.exec(path)?.[1];
    if (!connection && !id) return PASS;
    res.setHeader("Cache-Control", "no-store");
    const active = () => owner(auth) && !res.destroyed;
    const refused = () => json(res, 403, { error: "Only the local owner can configure memory." });
    if (!active()) return refused();
    if (id && !exists(id)) return json(res, 404, { error: "Unknown bot." });
    if (method === "GET") return json(res, 200, id ? memory.status(id) : memory.connectionStatus());
    if (method !== "PUT" && !(connection && method === "POST")) return json(res, 405, { error: "Unsupported memory settings method." });
    const body = await readBody(req);
    if (!active()) return refused();
    try {
      if (id) {
        if (!exists(id)) return json(res, 404, { error: "Unknown bot." });
        const parsed = memoryChangeSchema.safeParse(body);
        if (!parsed.success) return json(res, 400, { error: "Supply the bot's memory switch." });
        return json(res, 200, memory.change(id, parsed.data.enabled));
      }
      const parsed = memoryConnectionSchema.safeParse(body);
      if (!parsed.success) return json(res, 400, { error: "Supply the Mem0 address and service credential." });
      return json(res, 200, await memory.connect(parsed.data, active, method === "POST"));
    } catch (error) {
      if (error instanceof MemoryRefusal) return json(res, error.status, { error: error.message });
      throw error;
    }
  };
}
