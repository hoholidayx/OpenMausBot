import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, verificationServerArgs, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { fixtureImageBridge, fixturePng } from "./testing/image-bridge.ts";
import type { Message } from "./store.ts";

it("accepts a chat-only device, answers a second device, and resumes a lost MCP receipt after the Maus process dies", async () => {
  const upstream = await fixtureImageBridge();
  const fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, { scripted: true });
  const { url, dataDir } = fixture.info;
  const api = async (path: string, body?: object, token?: string, method = body ? "POST" : "GET", status?: number) => {
    const res = await fetch(url + path, { method, headers: { origin: url, "content-type": "application/json",
      ...(token ? { authorization: "Bearer " + token } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (status) expect(res.status).toBe(status); else expect(res.ok, method + " " + path).toBe(true);
    return res.json();
  };
  const pair = async (scopes: string[]) => (await api("/api/auth/pair", { code: (await api("/api/auth/pairing", { scopes })).code })).token as string;
  let replacement: ChildProcess | undefined;
  try {
    const a = await pair(["client"]), b = await pair(["admin","client"]);
    await api("/api/mcp/servers", { name: "pictures", type: "http", url: upstream.url, headers: {}, enabled: true });
    await api("/api/mcp/servers/pictures", { enabled: true }, undefined, "PATCH");
    await api("/api/images/mcp-test", { name: "pictures" }, a, "POST", 403);
    await api("/api/images/mcp-test", { name: "pictures" }, b);
    await api("/api/config", { imageGen: { asyncMcp: "pictures" } }, a, "PUT", 403);
    await api("/api/config", { imageGen: { asyncMcp: "pictures" } }, b, "PUT");
    const { bot } = await runControlOmb(["new-bot", "--name", "Lamp", "--url", url]) as { bot: { id: string; activeTaskId: string } };
    await api("/api/bots/" + bot.id, { computer: "off" }, b, "PATCH");
    const thread = bot.activeTaskId, route = "/api/threads/" + thread + "/messages";
    const rows = async (token: string): Promise<Message[]> => (await api(route, undefined, token)).messages;
    const send = (text: string, token: string) => api("/api/bots/" + bot.id + "/messages", { text, threadId: thread }, token);
    const plan = join(dataDir, "room-plan.json");
    writeFileSync(plan, JSON.stringify({ [bot.id]: { turns: [
      { steps: [{ tool: "generate_image_async", arguments: { prompt: "An amber lamp" } }], reply: "Queued the picture." },
      { reply: "The office opens at nine." },
    ] } }));
    upstream.control.loseReceipt = true;
    await send("Draw a lamp", a);
    await expect.poll(async () => (await rows(b)).some(m => m.text === "Queued the picture."), { timeout: 18_000 }).toBe(true);
    await send("When does the office open?", b);
    await expect.poll(async () => (await rows(b)).some(m => m.text === "The office opens at nine."), { timeout: 18_000 }).toBe(true);
    const history = await rows(b), card = history.find(m => m.imageJob)!;
    expect(card.replyToId).toBe(history.find(m => m.text === "Draw a lamp")?.id);
    expect(card.attachments).toBeUndefined();
    await expect.poll(() => upstream.tasks.size).toBe(1);
    const exited = once(fixture.child, "exit");
    fixture.child.kill("SIGKILL"); await exited;
    const env = verificationServerEnvironment({}, dataDir, Number(new URL(url).port));
    replacement = spawn(process.execPath, verificationServerArgs(env), { env, stdio: "ignore" });
    upstream.control.complete = true;
    await expect.poll(async () => (await fetch(url + "/api/health").catch(() => null))?.ok, { timeout: 16_000 }).toBe(true);
    await expect.poll(async () => (await rows(b)).find(m => m.id === card.id)?.imageJob?.state, { timeout: 18_000 }).toBe("done");
    const delivered = (await rows(a)).filter(m => m.imageJob);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].id).toBe(card.id);
    const file = basename(delivered[0].attachments![0].path);
    const download = (token: string) => fetch(url + "/api/attachments/" + file, { headers: { authorization: "Bearer " + token } });
    for (const token of [a,b]) expect(Buffer.from(await (await download(token)).arrayBuffer())).toEqual(fixturePng);
    expect(upstream.calls.filter(c => c.name === "image_submit")).toHaveLength(1);
    expect(file).not.toContain(upstream.tasks.keys().next().value);
    expect(readFileSync(plan + ".evidence.jsonl", "utf8").trim().split("\n")).toHaveLength(2);
    const db = new DatabaseSync(join(dataDir,"messages.db"), { readOnly: true });
    try { expect(db.prepare("SELECT used FROM image_days").get()?.used).toBe(1); } finally { db.close(); }
    await api("/api/bots/" + bot.id, { visibility: "admins" }, b, "PATCH");
    await api(route, undefined, a, "GET", 404);
    expect((await download(a)).status).toBe(404);
    expect((await download(b)).status).toBe(200);
  } finally {
    if (replacement && replacement.exitCode === null && replacement.signalCode === null) {
      const ended = once(replacement, "exit"); replacement.kill("SIGTERM"); await ended;
    }
    await fixture.close(); await upstream.close();
  }
}, 90_000);
