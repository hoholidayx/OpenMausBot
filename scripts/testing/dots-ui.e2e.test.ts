import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { dotsBridgeFixture, withRestartedDotsHost } from "../../server/testing/dots-bridge.ts";
import { launchVerificationServer } from "../control-omb.ts";
import { agentBrowser, ensureUiBrowser, sessionEnv } from "./control-omb-ui.ts";
import { fixtureApi, mountPreview } from "./preview-fixture.ts";

it.skipIf(process.env.OMB_UI_E2E !== "1")("keeps the Dots composer available and displays correlated incoming mail on desktop and mobile", async () => {
  const tools = await ensureUiBrowser(process.env);
  const local = await dotsBridgeFixture(false);
  const fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, undefined, [], undefined, undefined, local);
  const { url, dataDir } = fixture.info;
  const api = fixtureApi(url);
  const preview = await mountPreview(fixture, { entry: "/scripts/testing/threads-preview.tsx", route: "/__dots.html", title: "Dots inbox", logLevel: "warn" });
  const env = sessionEnv({ home: dataDir, session: "d", chrome: tools.chrome });
  const browser = (...args: string[]) => agentBrowser(tools.binary, env, args);
  const page = async (js: string) => (await browser("eval", js)).result;
  const screen = () => page("document.body.innerText");
  const composer = 'textarea[aria-label="Message Dots"]';
  const visible = `el => {
    if (!el) return false;
    const box = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
  }`;
  const send = async (text: string) => {
    await browser("fill", composer, text);
    const button = 'button[aria-label="Send message"]';
    await expect.poll(() => page(`(${visible})(document.querySelector(${JSON.stringify(button)}))`)).toBe(true);
    await browser("click", button);
  };
  try {
    await api("PUT", "/api/config", { language: "en" });
    const bots = (await api("GET", "/api/bots?messages=0")).bots;
    const dots = bots.find((bot: any) => bot.modelSelection.instanceId === "dots");
    for (const bot of bots) if (bot.defaultBot) await api("PATCH", "/api/bots/" + bot.id, { welcomed: true });
    const exited = once(fixture.child, "exit"); fixture.child.kill("SIGKILL"); await exited;
    const db = new DatabaseSync(join(dataDir, "messages.db"));
    try {
      const id = randomUUID(), at = Date.now();
      const tool = { name: "notice: Dots didn't hear back from Dots.", ok: true,
        rescue: { instanceId: "dots", ai: "Dots", botId: dots.id, threadId: dots.threadId, turnId: randomUUID(), over: true } };
      db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,json,search_text) VALUES (?,?,?,'bot','activity',?,'')")
        .run(dots.threadId, id, at, JSON.stringify({ role: "bot", kind: "activity", id, at, tool }));
      db.prepare("INSERT INTO thread_state VALUES (?,?) ON CONFLICT(thread_id) DO UPDATE SET active_leaf_id=excluded.active_leaf_id").run(dots.threadId, id);
    } finally { db.close(); }
    await withRestartedDotsHost(fixture.info, async () => {
      const row = '[data-sidebar-root] [data-sidebar-bot-row="' + dots.id + '"]';
      const selectInbox = () => expect.poll(() => page(`(() => {
        const onScreen = ${visible};
        if (onScreen(document.querySelector(${JSON.stringify(composer)}))) return true;
        const inbox = document.querySelector(${JSON.stringify(row)});
        if (onScreen(inbox)) inbox.click();
        return false;
      })()`), { timeout: 20_000 }).toBe(true);
      await browser("set", "viewport", "1440", "900");
      await browser("open", preview.previewUrl + "?" + new URLSearchParams({ thread: dots.threadId, bot: dots.id }));
      await selectInbox();
      expect(await screen()).not.toMatch(/hear back from Dots/);
      await send("Check the morning report");
      await expect.poll(() => local.sends.size).toBe(1);
      writeFileSync(join(dataDir, "stall-turns"), "");
      await browser("set", "viewport", "390", "844");
      await selectInbox();
      await send("Check the evening report");
      await expect.poll(() => local.sends.size).toBe(2);
      const [a, b] = [...local.sends.keys()];
      await browser("reload");
      await selectInbox();
      expect(await screen()).not.toMatch(/hear back|waiting for Dots|hasn't heard|stop and send/i);
      local.event({ kind: "progress", message_id: a, text: "Reading the first report" });
      local.event({ kind: "reply", message_id: b, text: "Evening report arrived" });
      local.event({ kind: "push", text: "Independent notification" });
      local.event({ kind: "reply", message_id: a, text: "Morning report arrived" });
      for (const [name, width, height] of [["mobile", "390", "844"], ["desktop", "1440", "900"]]) {
        await browser("set", "viewport", width, height);
        await expect.poll(screen, { timeout: 10_000 }).toContain("Morning report arrived");
        const bubbles = await page("Array.from(document.querySelectorAll('[data-look=message-bot]'), el => el.innerText)");
        expect(bubbles).toEqual(expect.arrayContaining([expect.stringMatching(/morning report[\s\S]*Reading the first report/),
          expect.stringMatching(/evening report[\s\S]*Evening report arrived/), expect.stringMatching(/morning report[\s\S]*Morning report arrived/)]));
        expect(await screen()).toContain("Independent notification");
        expect(await screen()).not.toMatch(/hear back from Dots/);
        expect(await page("document.documentElement.scrollWidth <= innerWidth + 1")).toBe(true);
        if (process.env.OMB_UI_EVIDENCE_DIR) {
          mkdirSync(process.env.OMB_UI_EVIDENCE_DIR, { recursive: true });
          await browser("screenshot", join(process.env.OMB_UI_EVIDENCE_DIR, name + ".png"));
        }
      }
    }, { OMB_FIRST_REPLY_NOTICE_MS: "150", OMB_TEST_STALL_CLOCK: "1" });
  } finally {
    await browser("close").catch(() => {});
    await preview.close();
    await fixture.close();
    await local.close();
  }
}, 120_000);
