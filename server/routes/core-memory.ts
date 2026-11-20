import { coreEditSchema, coreMemoryView, editCoreMemory } from "../core-memory.ts";
import { PASS, type RouteHandler } from "./table.ts";

export function coreMemoryRoutes(botExists: (id: string) => boolean): RouteHandler {
  return async ({ req, res, path, method, json, readBody }) => {
    const match = /^\/api\/bots\/([\w-]+)\/core-memory$/.exec(path);
    if (!match || (method !== "GET" && method !== "POST")) return PASS;
    const id = match[1];
    const edit = method === "POST" ? coreEditSchema.safeParse(await readBody(req)) : undefined;
    if (!botExists(id)) return json(res, 404, { error: "No such bot" });
    if (!edit) return json(res, 200, coreMemoryView(id));
    if (!edit.success) return json(res, 400, { error: edit.error.issues[0].message });
    try {
      return json(res, 200, editCoreMemory(id, edit.data));
    } catch (error) {
      if (!(error instanceof Error) || !("status" in error) || typeof error.status !== "number") throw error;
      return json(res, error.status, { error: error.message, ...(error.status === 409 ? { current: coreMemoryView(id) } : {}) });
    }
  };
}
