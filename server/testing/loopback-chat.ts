import { existsSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

export type ChatFixtureRequest = {
  model: string;
  stream: boolean;
  messages: Array<{ role: string; content: string | null; tool_call_id?: string }>;
  tools?: Array<{ function: { name: string } }>;
};
type ChatFixtureReply = {
  choice: { content?: string; tool_calls?: Array<{ id: string; index: number; type: string; function: { name: string; arguments: string } }> };
  finish_reason: string;
  usage?: { prompt_tokens: number; completion_tokens: number };
};

const key = "synthetic-fixture-key";
export const fixtureModel = "fixture-model";
export const fixtureChatSelection = (instanceId = "openaiCompat") => ({ instanceId, model: fixtureModel });

export async function waitForFixtureFile(path: string, signal: AbortSignal): Promise<void> {
  while (!existsSync(path)) await delay(20, undefined, { signal });
}

async function readChatRequest(request: IncomingMessage): Promise<ChatFixtureRequest> {
  let body = "";
  for await (const chunk of request) body += chunk;
  return JSON.parse(body) as ChatFixtureRequest;
}

export async function startLoopbackChat(respond: (request: ChatFixtureRequest, signal: AbortSignal, progress: (text: string) => void) => ChatFixtureReply | Promise<ChatFixtureReply> =
  () => ({ choice: { content: "Reply from the API fixture." }, finish_reason: "stop" })) {
  const requests: ChatFixtureRequest[] = [];
  const upstream = createServer(async (req, res) => {
    if (req.method === "GET") return res.end(JSON.stringify({ data: [{ id: fixtureModel }] }));
    if (req.headers.authorization !== `Bearer ${key}`) {
      res.writeHead(401);
      return res.end();
    }
    const closed = new AbortController();
    res.once("close", () => closed.abort());
    try {
      const request = await readChatRequest(req);
      requests.push(request);
      const chunk = (delta: ChatFixtureReply["choice"], finish_reason?: string, usage?: ChatFixtureReply["usage"]) => {
        if (closed.signal.aborted) return;
        if (!res.headersSent) res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }], usage })}\n\n`);
      };
      const { choice, finish_reason, usage } = await respond(request, closed.signal, text => {
        if (request.stream) chunk({ content: text });
      });
      if (closed.signal.aborted) return;
      if (!request.stream) {
        res.setHeader("Content-Type", "application/json");
        return res.end(JSON.stringify({ choices: [{ message: choice, finish_reason }], usage }));
      }
      chunk(choice, finish_reason, usage);
      res.end("data: [DONE]\n\n");
    } catch (error) {
      if (closed.signal.aborted) return;
      if (res.headersSent) return res.destroy();
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: String(error) } }));
    }
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("API fixture has no loopback address");
  const config = { key, url: `http://127.0.0.1:${address.port}/v1`, model: fixtureModel };
  return {
    requests,
    config,
    instance: (displayName: string) => ({ driver: "openai-compat" as const, displayName, config }),
    async connect(url: string) {
      const headers = { "content-type": "application/json", origin: url };
      for (const [method, path, body] of [
        ["PATCH", "/api/config", { openaiCompat: config }],
        ["POST", "/api/instances/openaiCompat/refresh-models", {}],
      ] as const) {
        const response = await fetch(url + path, { method, headers, body: JSON.stringify(body) });
        if (!response.ok) throw new Error(await response.text());
      }
    },
    async close() {
      upstream.closeAllConnections();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    },
  };
}

export const fixtureChatText = (request: ChatFixtureRequest) => request.messages.map(message => message.content).join("\n");

export function fixtureChatReply(content: string, tool?: { name: string; args: unknown; id?: string }, usage?: ChatFixtureReply["usage"]): ChatFixtureReply {
  const tool_calls = tool ? [{ id: tool.id ?? "fixture-call", index: 0, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] : undefined;
  return { choice: { ...(content ? { content } : {}), ...(tool_calls ? { tool_calls } : {}) }, finish_reason: tool_calls ? "tool_calls" : "stop", usage };
}
