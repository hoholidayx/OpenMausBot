import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { MobileMessagePage, MobileTextReceipt, MobileTextSend } from "../packages/phone-protocol/src/mobile-v1.ts";
import type { AuthPairResponse, BotsResponse } from "../packages/phone-protocol/src/responses.ts";
import { launchVerificationServer } from "../scripts/control-omb.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { prepareMobileChatFixture } from "./testing/mobile-api-fixture.ts";

const sample = JSON.parse(readFileSync(new URL("../packages/phone-protocol/fixtures/mobile-v1/chat.json", import.meta.url), "utf8"));

it("pins bounded history, accepted and queued receipts to the same paired direct conversation", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "omb-mobile-chat-"));
  const gate = join(scratch, "finish");
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: gate });
  try {
    const seed = await prepareMobileChatFixture(fixture);
    const headers = { "x-forwarded-proto": "https", "content-type": "application/json" };
    const call = (path: string, body?: unknown, token?: string) => fetch(fixture.info.url + path, {
      method: body ? "POST" : "GET", headers: { ...headers, ...(token && { authorization: "Bearer " + token }) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const pair = await call("/api/auth/pair", { code: seed.code, label: "Novia chat fixture" });
    expect(pair.status).toBe(200);
    const { token } = await pair.json() as AuthPairResponse;
    const post = (body: MobileTextSend) => call(`/api/bots/${seed.botId}/messages`, body, token);
    const page = async (thread: string, query: string): Promise<MobileMessagePage> => {
      const response = await call(`/api/threads/${thread}/messages?${query}`, undefined, token);
      expect(response.status).toBe(200);
      return await response.json() as MobileMessagePage;
    };
    const first: MobileTextSend = { ...sample.send, threadId: seed.threadA };
    const accepted = await post(first);
    expect(accepted.status).toBe(202);
    const stored = await accepted.json() as MobileTextReceipt;
    if (!("message" in stored)) throw new Error("Expected a stored line");
    const row = stored.message;
    expect(row.parentId === null || typeof row.parentId === "string").toBe(true);
    expect(stored).toMatchObject({ ...sample.accepted, threadId: seed.threadA, message: {
      ...sample.accepted.message, id: expect.any(String), at: expect.any(Number), parentId: row.parentId,
    } });
    const replay = await post(first);
    expect(replay.status).toBe(202);
    expect(await replay.json()).toMatchObject({ threadId: seed.threadA, message: { id: row.id } });
    expect((await post({ ...first, text: "Changed" })).status).toBe(409);

    const next = sample.latest.messages[1];
    const queued = await post({ threadId: seed.threadA, text: next.text, sendId: next.sendId, followUp: "queue" });
    expect(queued.status).toBe(202);
    const waiting = await queued.json() as MobileTextReceipt;
    if (!("queued" in waiting)) throw new Error("Expected a queue entry");
    expect(waiting).toMatchObject({ ...sample.queued, threadId: seed.threadA, queueId: expect.any(String) });
    const queues = await (await call("/api/bots?messages=0", undefined, token)).json() as BotsResponse;
    expect(queues.botQueuedMessages[seed.threadA]).toContainEqual(expect.objectContaining({
      ...sample.queues.botQueuedMessages["thread-a"][0], queueId: waiting.queueId,
    }));
    writeFileSync(gate, "finish");
    await expect.poll(async () => (await page(seed.threadA, "limit=50")).messages.find((line) => line.sendId === next.sendId),
      { timeout: 20_000 }).toMatchObject({ role: "user", kind: "text", text: next.text, queueId: waiting.queueId });
    const current = await page(seed.threadA, "limit=50");
    expect(current.messages.filter((line) => line.sendId === first.sendId)).toHaveLength(1);
    const anchor = current.messages.at(-1)!.id;
    const earlier = await page(seed.threadA, "limit=1&before=" + anchor);
    expect(earlier.messages.map((line) => line.id)).toEqual([current.messages.at(-2)!.id]);
    expect(typeof earlier.hasMore).toBe("boolean");
    expect(typeof earlier.activeLeafId).toBe("string");
    expect((await page(seed.threadB, "limit=50")).messages.some((line) => line.sendId === first.sendId)).toBe(false);
  } finally {
    await fixture.close();
    removeTempDir(scratch);
  }
}, 45_000);
