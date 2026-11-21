import type { VerificationServer } from "../../scripts/control-omb.ts";
import type { BotCreateResponse } from "../../packages/phone-protocol/src/responses.ts";

export async function prepareMobileFixture(fixture: VerificationServer) {
  const origin = fixture.info.url;
  async function owner<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(origin + path, {
      method, headers: { origin, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Fixture ${method} ${path} returned ${response.status}`);
    return await response.json() as T;
  }
  const visible = (await owner<BotCreateResponse>("POST", "/api/bots", { name: "Novia partner" })).bot;
  await owner("PATCH", `/api/bots/${visible.id}`, { color: "purple" });
  const hidden = (await owner<BotCreateResponse>("POST", "/api/bots", { name: "Private fixture partner" })).bot;
  await owner("PATCH", `/api/bots/${hidden.id}`, { visibility: "admins" });
  const pairing = await owner<{ code: string }>("POST", "/api/auth/pairing", { label: "Novia fixture", scopes: ["client"] });
  return {
    code: pairing.code,
    visible: { id: visible.id, threadId: visible.threadId },
    hidden: { id: hidden.id, threadId: hidden.threadId },
    revoke: (id: string) => owner("DELETE", `/api/auth/sessions/${encodeURIComponent(id)}`),
  };
}
