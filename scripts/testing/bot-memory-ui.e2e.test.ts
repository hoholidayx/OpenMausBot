import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../control-omb.ts";
import { fixtureMemory } from "../../server/testing/memory-mcp.ts";
import { agentBrowser, ensureUiBrowser, sessionEnv } from "./control-omb-ui.ts";
import { mountPreview } from "./preview-fixture.ts";

it("connects Mem0 once and toggles two bots independently on desktop and mobile", async () => {
  const tools = await ensureUiBrowser(process.env);
  const fixture = await launchVerificationServer();
  const { url, dataDir, logPath } = fixture.info;
  const upstream = fixtureMemory();
  const mem = await upstream.start();
  const preview = await mountPreview(fixture, { entry: "/src/testing/bot-settings.tsx", route: "/__bot-settings.html", title: "Memory settings", logLevel: "warn" });
  const env = sessionEnv({ home: dataDir, session: "m", chrome: tools.chrome });
  const browser = async (...args: string[]) => {
    try { return await agentBrowser(tools.binary, env, args); } catch (cause) {
      const snapshot = await agentBrowser(tools.binary, env, ["snapshot"]);
      throw new Error(args[0] + " " + args[1] + ": " + String(snapshot.snapshot).slice(0, 5000), { cause });
    }
  };
  const evaluate = async (script: string) => (await browser("eval", script)).result;
  const card = 'section[aria-label="Long-term memory"]';
  const toggle = card + ' [role="switch"]';
  const click = async (selector: string) => {
    await browser("wait", selector).catch(async () => { throw new Error(selector + " missing: " + String((await browser("snapshot")).snapshot).slice(0, 2600)); });
    await browser("click", selector);
  };
  try {
    const create = async (name: string) => (await runControlOmb(["new-bot", "--name", name, "--url", url]) as { bot: { id: string } }).bot;
    const first = await create("Memory fixture"), second = await create("Other fixture");
    const status = async (id: string) => await (await fetch(url + "/api/bots/" + id + "/long-term-memory")).json() as { configured: boolean; enabled: boolean };
    const selectBot = async (name: string) => {
      await browser("open", preview.previewUrl);
      await expect.poll(() => evaluate("document.body.innerText"), { timeout: 25_000 }).toContain(name);
      await evaluate(`Array.from(document.querySelectorAll("button")).find(b => b.textContent.includes(${JSON.stringify(name)})).click()`);
    };
    await selectBot("Memory fixture");
    const mode = (advanced: boolean) => evaluate(`localStorage.setItem("omb-advanced-mode", "${advanced ? 1 : 0}"); window.dispatchEvent(new StorageEvent("storage", {key: "omb-advanced-mode", storageArea: localStorage})); true`);
    await mode(false);
    await browser("find", "text", "Open settings", "click", "--exact");
    await browser("wait", "[data-panel-gear]");
    if (!await evaluate('!!document.querySelector("[data-panel-page=apps]")')) {
      await click('[data-panel-gear]');
    }
    await click('[data-panel-page="apps"]');
    await click(toggle);
    await browser("wait", card + ' [name="url"]');
    await browser("fill", card + ' [name="url"]', mem.url);
    await browser("fill", card + ' [name="token"]', "intentionally-wrong-test-credential");
    await click(card + ' button[type="submit"]');
    await browser("wait", card + ' [role="alert"]');
    expect(await evaluate(`document.querySelector('${card} input[type=password]').value`)).toBe("");
    expect((await status(first.id)).enabled).toBe(false);
    await browser("fill", card + ' [name="token"]', upstream.serviceToken);
    await click(card + ' button[type="submit"]');
    await expect.poll(async () => (await status(first.id)).enabled).toBe(true);
    await browser("wait", toggle + '[aria-checked=true]');
    await browser("screenshot", logPath + ".memory-midnight.png");
    await click(toggle);
    await expect.poll(async () => (await status(first.id)).enabled).toBe(false);
    expect(await status(second.id)).toMatchObject({ configured: true, enabled: false });
    await selectBot("Other fixture");
    await browser("set", "viewport", "390", "844");
    await evaluate("document.documentElement.dataset.skin = 'daylight'");
    await mode(true);
    await browser("find", "text", "Open settings", "click", "--exact");
    await browser("find", "role", "button", "click", "--name", "Access", "--exact");
    await click(toggle);
    await browser("wait", toggle + '[aria-checked=true]');
    expect(await status(second.id)).toMatchObject({ enabled: true });
    expect(await status(first.id)).toMatchObject({ enabled: false });
    expect(await evaluate(`(() => { const card = document.querySelector('${card}'); return card.scrollWidth <= card.clientWidth && !card.querySelector('input'); })()`)).toBe(true);
    await browser("screenshot", logPath + ".memory-daylight.png");
    await browser("find", "role", "button", "click", "--name", "Add an MCP server…", "--exact");
    const global = 'section[aria-label="Mem0"]';
    await browser("wait", global);
    await browser("find", "role", "button", "click", "--name", "Edit connection", "--exact");
    expect(await evaluate(`document.querySelector('${global} input[type=password]').value`)).toBe("");
    expect(await evaluate(`document.querySelector('${global} input[type=url]').value`)).toBe(mem.url);
    await browser("fill", global + ' [name="token"]', upstream.serviceToken);
    await click(global + ' button[type="submit"]');
    await expect.poll(() => evaluate(`document.querySelector('${global}').innerText`)).toContain("Edit connection");
    expect(await status(second.id)).toMatchObject({ enabled: true });
    expect(await status(first.id)).toMatchObject({ enabled: false });
  } finally {
    await browser("close").catch(() => {});
    await Promise.all([preview.close(), mem.close(), fixture.close()]);
  }
}, 120_000);
