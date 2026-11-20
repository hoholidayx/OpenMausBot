import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { fixtureApi } from "../scripts/testing/preview-fixture.ts";
import { fixtureImageBridge } from "./testing/image-bridge.ts";
import { fixtureChatReply, fixtureChatSelection, startLoopbackChat } from "./testing/loopback-chat.ts";
import { openSse, type SseRecorder } from "./testing/sse.ts";

it("gives the local image tool only to eligible turns and checks device access again before acceptance", async () => {
  const fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, { scripted: true });
  const { url, dataDir } = fixture.info;
  const remote = await fixtureImageBridge();
  const streams: SseRecorder[] = [];
  let act: (() => Promise<void>) | undefined;
  let toolReply = "";
  const provider = await startLoopbackChat(async (request) => {
    const last = request.messages.at(-1);
    if (last?.role === "tool") {
      toolReply = String(last.content);
      return fixtureChatReply("Tool returned.");
    }
    if (act) {
      const before = act;
      act = undefined;
      await before();
      const tool = request.tools?.find((t) => t.function.name.endsWith("generate_image_async"));
      if (tool) return fixtureChatReply("", { name: tool.function.name, args: { prompt: "A candle" } });
      const use = request.tools?.find((t) => t.function.name.endsWith("use_tool"));
      if (use)
        return fixtureChatReply("", {
          name: use.function.name,
          args: { name: "generate_image_async", arguments: { prompt: "A candle" } },
        });
    }
    return fixtureChatReply("Finished fixture turn.");
  });
  const admin = fixtureApi(url);
  const cli = (...args: string[]) => runControlOmb([...args, "--url", url]) as Promise<any>;
  const device = async (scopes: string[], script = false) => {
    const code = (await admin("POST", "/api/auth/pairing", { scopes, ...(script ? { tokenTtlMs: 120_000 } : {}) }))
      .code;
    return (await admin("POST", "/api/auth/pair", { code })).token as string;
  };
  const tools = (from: number) =>
    provider.requests.slice(from).flatMap((r) => r.tools?.map((t) => t.function.name) ?? []);
  const onlyImage = (names: string[]) =>
    names.filter((n) => /generate_image|image_submit|image_status|image_result/.test(n));
  try {
    await provider.connect(url);
    const user = await device(["client", "admin"]),
      script = await device(["client", "admin"], true);
    const a = (await cli("new-bot", "--name", "Image access")).bot,
      path = "/api/bots/" + a.id,
      thread = a.activeTaskId;
    await admin("PATCH", path, {
      modelSelection: fixtureChatSelection(),
      computer: "off",
      approvalMode: "full",
      toolScope: { allow: ["mcp:agents:generate_image_async"] },
    });
    for (const name of ["pictures", "pictures-alias"]) {
      await admin("POST", "/api/mcp/servers", { name, type: "http", url: remote.url, enabled: true });
      await admin("PATCH", "/api/mcp/servers/" + name, { enabled: true });
    }
    await admin("PUT", "/api/config", { imageGen: { asyncMcp: "pictures" } });
    const run = async (token?: string) => {
      const from = provider.requests.length;
      await fixtureApi(url, { headers: token ? { authorization: "Bearer " + token } : {} })(
        "POST",
        path + "/messages",
        { threadId: thread, text: "Fixture request " + from },
      );
      await cli("wait", "--bot", a.id, "--task", thread, "--timeout", "15");
      expect(provider.requests.length).toBeGreaterThan(from);
      return onlyImage(tools(from));
    };
    expect((await run(user)).some((n) => n.endsWith("generate_image_async"))).toBe(true);
    expect(await run(script)).toEqual([]);
    expect(await run()).toEqual([]);
    await admin("PATCH", path, { mcpServers: [] });
    expect(await run(user)).toEqual([]);
    await admin("PATCH", path, { mcpServers: ["pictures"], toolsOff: ["images"] });
    expect(await run(user)).toEqual([]);
    await admin("PATCH", path, { toolsOff: [], toolScope: { deny: ["mcp:agents:generate_image"] } });
    expect(await run(user)).toEqual([]);
    await admin("PATCH", path, { toolScope: { allow: ["mcp:agents:generate_image_async"] } });
    const spare = await device(["client", "admin"]);
    const id = (await fixtureApi(url, { headers: { authorization: "Bearer " + spare } })("GET", "/api/auth/sessions"))
      .current;
    act = () => admin("DELETE", "/api/auth/sessions/" + id);
    await run(spare);
    expect(toolReply).toMatch(/paired|authorized|permission|denied|cannot|scope/i);
    expect(remote.tasks.size).toBe(0);
    const room = (await admin("POST", "/api/groups", { name: "Image room", memberIds: [a.id] })).group;
    await admin("PATCH", "/api/groups/" + room.id + "/setup", { action: "skip" });
    let from = provider.requests.length;
    await cli("send-channel", "--channel", room.id, "--text", "Room question");
    await cli("wait", "--channel", room.id, "--timeout", "15");
    expect(provider.requests.length).toBeGreaterThan(from);
    expect(onlyImage(tools(from))).toEqual([]);
    from = provider.requests.length;
    const routine = (
      await admin("POST", "/api/routines", {
        name: "Image routine",
        prompt: "Routine question",
        botId: a.id,
        enabled: false,
        schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 },
      })
    ).routine;
    const { run: scheduled } = await admin("POST", "/api/routines/" + routine.id + "/run", {});
    await expect
      .poll(
        async () =>
          (await admin("GET", "/api/routines")).runs.find((r: { id: string }) => r.id === scheduled.id)?.status,
        { timeout: 20_000 },
      )
      .toBe("completed");
    expect(provider.requests.length).toBeGreaterThan(from);
    expect(onlyImage(tools(from))).toEqual([]);
    from = provider.requests.length;
    const external = await admin("POST", path + "/bot-api", { enabled: true });
    await admin("POST", path + "/bot-api/acts-as-owner", { enabled: true });
    expect(
      (
        await fetch(external.url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer " + external.key },
          body: JSON.stringify({ message: "Outside request", wait: 15 }),
        })
      ).status,
    ).toBe(200);
    expect(provider.requests.length).toBeGreaterThan(from);
    expect(onlyImage(tools(from))).toEqual([]);
    const { bot: sender } = await cli("new-bot", "--name", "Delegator");
    writeFileSync(
      join(dataDir, "room-plan.json"),
      JSON.stringify({
        [sender.id]: {
          steps: [
            { tool: "coordinate_bots", arguments: { bot_ids: [a.id], message: "Delegated question", thread: "new" } },
          ],
          reply: "Sent",
          resumeReply: "Received",
        },
      }),
    );
    from = provider.requests.length;
    await cli("send", "--bot", sender.id, "--task", sender.activeTaskId, "--text", "Delegate the question");
    await expect.poll(() => provider.requests.length, { timeout: 20_000 }).toBeGreaterThan(from);
    await cli("wait", "--bot", sender.id, "--task", sender.activeTaskId, "--timeout", "15");
    expect(onlyImage(tools(from))).toEqual([]);
    expect(remote.tasks.size).toBe(0);
    const accepted = await device(["client", "admin"]);
    const session = (
      await fixtureApi(url, { headers: { authorization: "Bearer " + accepted } })("GET", "/api/auth/sessions")
    ).current;
    await admin("PATCH", path, { mcpServers: ["pictures", "pictures-alias"], toolScope: null });
    await admin("PUT", "/api/config", { features: { agentsToolBridge: true } });
    from = provider.requests.length;
    act = async () => {};
    expect(await run(accepted)).toEqual([]);
    expect(tools(from).some((n) => n.endsWith("use_tool"))).toBe(true);
    expect(toolReply).toContain("Image queued in this chat");
    await expect.poll(() => remote.tasks.size).toBe(1);
    await admin("DELETE", "/api/auth/sessions/" + session);
    const history = "/api/threads/" + thread + "/messages";
    expect((await fetch(url + history, { headers: { authorization: "Bearer " + accepted } })).status).toBe(401);
    const observer = await device(["client"]);
    await admin("PATCH", path, { visibility: "admins" });
    for (const token of [user, observer])
      streams.push(await openSse(url + "/api/events", { origin: url, authorization: "Bearer " + token }));
    remote.control.complete = true;
    const delivered = (frame: { kind: string; threadId?: string; message?: { imageJob?: { state: string } } }) =>
      frame.kind === "message.patch" && frame.threadId === thread && frame.message?.imageJob?.state === "done";
    await streams[0]!.until(delivered, 12_000);
    const marker = (await cli("new-bot", "--name", "Stream marker")).bot;
    await streams[1]!.until((frame) => frame.kind === "bot" && frame.bot?.id === marker.id);
    expect(streams[1]!.frames.some(delivered)).toBe(false);
    await expect
      .poll(
        async () =>
          (await admin("GET", history)).messages.filter(
            (m: { imageJob?: { state: string } }) => m.imageJob?.state === "done",
          ).length,
        { timeout: 12_000 },
      )
      .toBe(1);
  } finally {
    for (const stream of streams) stream.close();
    await fixture.close();
    await provider.close();
    await remote.close();
  }
}, 100_000);
