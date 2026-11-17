import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createTalkServer, QUICK_ASKS_TITLE, type TalkChat, type TalkUpdate } from "../electron/talk-server.mjs";
import { launchVerificationServer, verificationServerArgs, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";
import { applyPendingWorkspaceRestore, commitPendingWorkspaceRestore, stageWorkspaceBackup } from "./workspace-backup.ts";

const owner = randomBytes(32).toString("base64url");
const realFetch = globalThis.fetch;
let fixture: Awaited<ReturnType<typeof launchVerificationServer>>;
const request = (route: string, init?: RequestInit) => fetch(`${fixture.info.url}${route}`, init);

beforeAll(async () => {
  globalThis.fetch = (input, init = {}) => realFetch(input, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), "x-openmausbot-desktop-owner": owner } });
  fixture = await launchVerificationServer({ ...process.env, OMB_TEST_DESKTOP_OWNER_TOKEN: owner });
}, 90_000);
afterAll(async () => {
  globalThis.fetch = realFetch;
  await fixture?.close();
});

it("asks MausBot in its own Quick asks chat, as the desktop app does, and follows the reply to the end", async () => {
  const descriptor = await (await request("/.well-known/openmausbot/environment")).json() as { capabilities: Record<string, unknown> };
  expect(descriptor.capabilities).not.toHaveProperty("move");
  for (const [method, path] of [
    ["GET", "/api/move/freeze"], ["POST", "/api/move/freeze"], ["POST", "/api/move/forget"],
    ["GET", "/api/cloud-send"], ["GET", "/api/cloud-send/manifest"], ["POST", "/api/cloud-send/chats"],
    ["POST", "/api/cloud-move"], ["GET", "/api/cloud-connections"], ["POST", "/api/cloud-connections/connected-apps"],
    ["POST", "/api/team-move-in"], ["GET", "/api/places/elsewhere"],
  ] as const) {
    expect((await request(path, { method })).status, `${method} ${path}`).toBe(404);
  }
  expect((await request("/api/workspace/activity")).status).toBe(200);
  let saved: TalkChat | null = null;
  const talk = createTalkServer({ request, serverKey: () => "fixture", prefs: { quickAsksChat: () => saved, setQuickAsksChat: (_s, chat) => { saved = chat; } } });
  const before = (await (await request("/api/bots?messages=0")).json() as any).bots.find((b: any) => b.defaultBot);
  const chat = await talk.prepare();
  expect(chat.botId).toBe(before.id);
  const updates: TalkUpdate[] = [];
  expect(await talk.ask({ chat, text: "What can you do?", sendId: randomUUID(), signal: AbortSignal.timeout(60_000), onUpdate: u => updates.push(u) })).toBe("done");
  expect(updates[0]).toEqual({ kind: "thinking" });
  expect(updates.at(-1)).toMatchObject({ kind: "done", ok: true, text: expect.stringContaining("hello from fake claude") });
  const after = (await (await request("/api/bots?messages=0")).json() as any).bots.find((b: any) => b.id === chat.botId);
  expect(after.threadId).toBe(before.threadId);
  expect(after.tasks.find((t: any) => t.threadId === chat.threadId).title).toBe(QUICK_ASKS_TITLE);
  expect(await talk.prepare()).toEqual(chat);
}, 90_000);

it("keeps a migrated workspace read-only across startup and lets its owner export it", async () => {
  let saved: TalkChat | null = null;
  const prefs = { quickAsksChat: () => saved, setQuickAsksChat: (_s: string, chat: TalkChat) => { saved = chat; } };
  const chat = await createTalkServer({ request, serverKey: () => "fixture", prefs }).prepare();
  await waitForExit(fixture.child, { signal: "SIGTERM" });
  const marker = join(fixture.info.dataDir, "moved.json");
  const bytes = JSON.stringify({ v: 1, at: 1, place: "Fixture destination" });
  writeFileSync(marker, bytes);
  const recovery = mkdtempSync(join(tmpdir(), "omb-retired-copy-"));
  const env = verificationServerEnvironment({ OMB_TEST_DESKTOP_OWNER_TOKEN: owner }, recovery, Number(new URL(fixture.info.url).port));
  env.OMB_DATA_DIR = fixture.info.dataDir;
  const restarted = spawn(process.execPath, verificationServerArgs(env), { env, stdio: "ignore" });
  try {
    await expect.poll(async () => {
      try { return (await (await request("/api/health")).json() as { pid: number }).pid; } catch { return undefined; }
    }, { timeout: 20_000 }).toBe(restarted.pid);
    expect((await request("/api/bots?messages=0")).status).toBe(200);
    const fresh = createTalkServer({ request, serverKey: () => "fixture", prefs: { quickAsksChat: () => null, setQuickAsksChat: () => {} } });
    await expect(fresh.prepare()).rejects.toMatchObject({ name: "TalkServerError", code: "moved" });
    const talk = createTalkServer({ request, serverKey: () => "fixture", prefs });
    expect(await talk.prepare()).toEqual(chat);
    await expect(talk.ask({ chat, text: "Still there?", sendId: randomUUID(), signal: AbortSignal.timeout(30_000), onUpdate: () => {} }))
      .rejects.toMatchObject({ name: "TalkServerError", code: "moved" });
    const password = "fixture backup password";
    const exported = await request("/api/workspace-backup/export", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }),
    });
    expect(exported.status, exported.ok ? undefined : await exported.text()).toBe(200);
    const { id } = await exported.json() as { id: string };
    const download = await request(`/api/workspace-backup/download/${id}`);
    expect(download.status).toBe(200);
    const archive = join(recovery, "source.ombbackup");
    writeFileSync(archive, Buffer.from(await download.arrayBuffer()));
    const target = join(recovery, "restored");
    mkdirSync(target);
    const staged = await stageWorkspaceBackup(target, archive, { password });
    commitPendingWorkspaceRestore(target, staged.id);
    expect(applyPendingWorkspaceRestore(target).restored).toBe(true);
    expect(existsSync(join(target, "moved.json"))).toBe(false);
    expect(readFileSync(marker, "utf8")).toBe(bytes);
  } finally {
    await waitForExit(restarted, { signal: "SIGTERM" });
    rmSync(recovery, { recursive: true, force: true });
  }
}, 90_000);
