// Real server, the repository's fake ACP engine holding a room's first turn until it is stopped.
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";
import { fixtureChatReply, fixtureModel, startLoopbackChat } from "./testing/loopback-chat.ts";
import { openSse } from "./testing/sse.ts";

it("stops a room's turn once per stopId: a resent Stop leaves the turn that started since running", async () => {
  const fixture = await launchVerificationServer();
  const { url } = fixture.info;
  let firstStarted = false;
  let secondStarted = false;
  let releaseSecond = false;
  const provider = await startLoopbackChat(async (request, signal) => {
    if (!request.stream) return fixtureChatReply("Ready.");
    const text = request.messages.at(-1)?.content ?? "";
    if (text.includes("Second message")) {
      secondStarted = true;
      while (!releaseSecond) await delay(30, undefined, { signal });
      return fixtureChatReply("Second message received.");
    }
    firstStarted = true;
    await delay(60_000, undefined, { signal });
    return fixtureChatReply("First message received.");
  });
  let stream: Awaited<ReturnType<typeof openSse>> | undefined;
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(url + path, {
      method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    });
    const value = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBe(status);
    return value;
  };
  const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as any[];
  try {
    await provider.connect(url);
    stream = await openSse(`${url}/api/events`, { origin: url });

    const { bot } = await api("POST", "/api/bots", { name: "Stopper", modelSelection: { instanceId: "openaiCompat", model: fixtureModel } }, 201);
    const { group } = await api("POST", "/api/groups", { name: "Stop room", memberIds: [bot.id] }, 201);
    await api("PATCH", `/api/groups/${group.id}/setup`, { action: "complete", cwd: null, bulletin: "", defaultResponder: { kind: "member", botId: bot.id } });
    const threadId = group.threadId;
    await api("POST", `/api/groups/${group.id}/messages`, { threadId, text: "Hold this one, please." }, 202);
    await expect.poll(() => firstStarted, { timeout: 20_000 }).toBe(true);
    const first = (await stream.until((frame) => frame.kind === "runtime" && frame.event?.type === "turn.started" && frame.event.threadId === threadId)).event.turnId;

    const stopId = "stop_room_0123456789abcdef";
    await api("POST", `/api/groups/${group.id}/interrupt`, { threadId, stopId });
    await stream.until((frame) => frame.kind === "runtime" && frame.event?.type === "turn.completed" && frame.event.turnId === first);
    await expect.poll(async () => (await api("GET", "/api/bots")).groups.find((room: any) => room.id === group.id)?.working ?? false, { timeout: 20_000 }).toBe(false);

    await api("POST", `/api/groups/${group.id}/messages`, { threadId, text: "Second message" }, 202);
    await expect.poll(() => secondStarted, { timeout: 20_000 }).toBe(true);
    const second = (await stream.until((frame) => frame.kind === "runtime" && frame.event?.type === "turn.started"
      && frame.event.threadId === threadId && frame.event.turnId !== first)).event.turnId;

    // The phone's connection died before it read the answer, so it sends the same Stop again.
    expect(await api("POST", `/api/groups/${group.id}/interrupt`, { threadId, stopId })).toEqual({ ok: true });
    releaseSecond = true;
    const done = await stream.until((frame) => frame.kind === "runtime" && frame.event?.type === "turn.completed" && frame.event.turnId === second);
    expect(done.event.ok, "the resent Stop cancelled the second turn").toBe(true);
    await expect.poll(async () => (await messages(threadId)).some((message) => message.kind === "text" && message.text === "Second message received."), { timeout: 20_000 }).toBe(true);

    expect(await api("POST", `/api/groups/${group.id}/interrupt`, { threadId, stopId: "not an id" }, 400)).toEqual({ error: "stopId must be a client-generated id" });
  } finally {
    stream?.close();
    await fixture.close();
    await provider.close();
  }
}, 120_000);
