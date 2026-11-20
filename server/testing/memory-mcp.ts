import type { IncomingHttpHeaders } from "node:http";
import { randomUUID } from "node:crypto";
import { BOT_MEMORY_TOOLS } from "../../shared/bot-memory.ts";
import { startFakeHttpMcp } from "./fake-http-mcp-server.ts";

export function fixtureMemory() {
  const roles = new Map<string, { userId: string; agentId: string }>();
  let serviceToken = randomUUID();
  const scope = (headers: IncomingHttpHeaders) => {
    const userId = headers["x-mem0-user-id"], agentId = headers["x-mem0-agent-id"];
    if (headers.authorization === `Bearer ${serviceToken}`) {
      return typeof userId === "string" && typeof agentId === "string" && userId && agentId ? { userId, agentId } : undefined;
    }
    if (!userId && !agentId) return roles.get(String(headers.authorization));
  };
  const rows = new Map<string, { id: string; memory: string; userId: string; agentId: string }>();
  const result = (data: object, isError = false) => ({ isError, content: [{ type: "text", text: JSON.stringify(data) }], ...(isError ? {} : { structuredContent: data }) });
  const fields = Object.fromEntries(["query", "text", "memoryId", "userId", "agentId", "scope"].map(key => [key, { type: "string" }]));
  return {
    get serviceToken() { return serviceToken; },
    rotateServiceToken() { serviceToken = randomUUID(); },
    role(userId: string, agentId: string) {
      const token = randomUUID();
      roles.set(`Bearer ${token}`, { userId, agentId });
      return token;
    },
    rows,
    start: () => startFakeHttpMcp({
      serverName: "mem0-mcp-lan", acceptBearer: (_auth, headers) => Boolean(scope(headers)),
      tools: BOT_MEMORY_TOOLS.map(name => ({ name, description: name, inputSchema: { type: "object", properties: fields } })),
      callResult(frame, headers) {
        const { name, arguments: args } = frame as { name: string; arguments: Record<string, string> };
        const role = scope(headers)!;
        if (args.userId && args.userId !== role.userId || args.agentId && args.agentId !== role.agentId) return result({ code: "scope_denied" }, true);
        if (args.scope === "session") return result({ code: "session_unavailable" }, true);
        const visible = [...rows.values()].filter(row => row.userId === role.userId && row.agentId === role.agentId);
        if (name === "memory_add") {
          const row = { ...role, id: randomUUID(), memory: args.text! };
          rows.set(row.id, row);
          return result({ memories: [row] });
        }
        if (name === "memory_search" || name === "memory_list") return result({ memories: visible });
        const row = visible.find(one => one.id === args.memoryId);
        if (!row) return result({ code: "not_found" }, true);
        if (name === "memory_update") row.memory = args.text!;
        if (name === "memory_delete") { rows.delete(row.id); return result({ deleted: [row.id] }); }
        return result({ memory: row });
      },
    }),
  };
}
