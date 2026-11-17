// Production UI and browser installability, in an owned disposable profile.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, type VerificationServer } from "../control-omb.ts";
import { waitForExit } from "../../server/testing/cleanup.ts";
import { ensureUiBrowser } from "./control-omb-ui.ts";
import { fixtureApi } from "./preview-fixture.ts";
import { threadWebRefUrl } from "../../src/lib/thread-refs.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const enabled = process.env.OMB_UI_E2E === "1";
const build = process.env.OMB_WEB_APP_BUILD || join(root, "dist");
const userText = "请帮我把这段较长的消息按手机的可用宽度显示。".repeat(5);
const botText = "这是一段较长的机器人回复，用来确认手机上的聊天气泡有足够的空间让中文自然换行。".repeat(5);
const shortBotText = "收到。";
if (!enabled) console.log("skipping web app UI: build the UI and set OMB_UI_E2E=1 for browser qualification");

async function connect(url: string) {
  const socket = new WebSocket(url);
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  const events: string[] = [];
  let next = 0;
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.method) { events.push(message.method); if (events.length > 20) events.shift(); }
    const waiting = pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id);
    if (message.error) waiting.reject(new Error(message.error.message));
    else waiting.resolve(message.result);
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("Fixture Chrome connection failed")), { once: true });
  });
  return {
    close: () => {
      for (const waiting of pending.values()) waiting.reject(new Error("Fixture Chrome connection closed"));
      pending.clear();
      socket.close();
    },
    request(method: string, params: unknown = {}, sessionId?: string): Promise<any> {
      const id = ++next;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Fixture Chrome ${method} timed out: ${events.join(", ")}`)); }, 30_000);
        pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
  };
}

(enabled ? it : it.skip)("qualifies the served phone web app and keeps controls inside safe areas", async () => {
  if (!existsSync(join(build, "index.html"))) throw new Error("Run pnpm build before OMB_UI_E2E=1 web-app qualification");
  let fixture: VerificationServer | undefined;
  let chrome: ChildProcess | undefined;
  let cdp: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    const tools = await ensureUiBrowser();
    if (!tools.chrome) throw new Error("This recipe needs the pinned Chrome for Testing");
    fixture = await launchVerificationServer({ FAKE_CLAUDE_REPLIES: JSON.stringify([[botText, shortBotText]]) }, undefined, undefined, undefined, undefined, undefined, [], undefined, build);
    const { url, dataDir, logPath } = fixture.info;
    const api = fixtureApi(url);
    const { bots } = await api("GET", "/api/bots") as { bots: Array<{ id: string; defaultBot?: object }> };
    for (const starter of bots.filter(bot => bot.defaultBot)) await api("PATCH", `/api/bots/${starter.id}`, { welcomed: true });
    const { bot } = await runControlOmb(["new-bot", "--name", "Pepper", "--url", url]) as { bot: { id: string; activeTaskId: string } };
    const profile = join(dataDir, "chrome");
    mkdirSync(profile, { recursive: true });
    chrome = spawn(tools.chrome, ["--headless=new", "--no-sandbox", "--no-first-run", "--no-default-browser-check",
      "--disable-background-networking", "--password-store=basic", "--use-mock-keychain", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], {
      env: { PATH: process.env.PATH, HOME: dataDir, USERPROFILE: dataDir, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
      stdio: "ignore",
    });
    const portFile = join(profile, "DevToolsActivePort");
    await expect.poll(() => existsSync(portFile), { timeout: 20_000 }).toBe(true);
    const [port, endpoint] = readFileSync(portFile, "utf8").trim().split("\n");
    cdp = await connect(`ws://127.0.0.1:${port}${endpoint}`);
    const target = await cdp.request("Target.createTarget", { url: "about:blank" });
    const attached = await cdp.request("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    const session = attached.sessionId as string;
    const request = (method: string, params: unknown = {}) => cdp!.request(method, params, session);
    const evaluate = async (expression: string) => {
      const value = await request("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (value.exceptionDetails) throw new Error(value.exceptionDetails.text);
      return value.result.value;
    };
    await request("Page.enable");
    await request("Page.addScriptToEvaluateOnNewDocument", { source: `
      localStorage.setItem('omb-analytics-opt-out', '1');
      localStorage.setItem('grok-move-2026-11', '1');
      localStorage.setItem('omb-email-gate', 'skipped');
      localStorage.setItem('omb-language', 'en');
      localStorage.setItem('omb-advanced-mode', '0');
      localStorage.setItem('omb-skin', 'system');
      localStorage.setItem('omb-simple-mode-prompt', '1');
    ` });
    await request("Runtime.enable");
    await request("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
    await request("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await request("Page.navigate", { url: threadWebRefUrl({ botId: bot.id, threadId: bot.activeTaskId }, url) });
    await expect.poll(() => evaluate("document.querySelector('textarea[aria-label^=\"Message\"]') !== null"), { timeout: 20_000 }).toBe(true);
    // iOS automatically zooms small form text on focus, leaving a standalone
    // window shifted after the keyboard closes. Keep the mention mirror aligned.
    const touchText = await evaluate(`(() => {
      const input = document.querySelector('textarea[aria-label^="Message"]');
      return { input: parseFloat(getComputedStyle(input).fontSize),
        mirror: parseFloat(getComputedStyle(document.querySelector('.mention-editor-mirror')).fontSize) };
    })()`);
    expect(touchText.input).toBeGreaterThanOrEqual(16);
    expect(touchText.mirror).toBe(touchText.input);
    const parsed = await request("Page.getAppManifest");
    expect(parsed.url).toBe(`${url}/manifest.webmanifest`);
    expect(parsed.errors).toEqual([]);
    const installability = await request("Page.getInstallabilityErrors");
    expect(installability.installabilityErrors).toEqual([]);
    await expect.poll(() => evaluate("document.querySelector('textarea[aria-label^=\"Message\"]') !== null"), { timeout: 20_000 }).toBe(true);
    for (const [width, height, insets] of [[390, 844, { top: 44, bottom: 34, left: 0, right: 0 }],
      [844, 390, { top: 0, bottom: 21, left: 44, right: 44 }]] as const) {
      await request("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: true });
      await request("Emulation.setSafeAreaInsetsOverride", { insets });
      const box = await evaluate(`(() => { const root=document.getElementById('root').getBoundingClientRect();
        const input=document.querySelector('textarea[aria-label^="Message"]').getBoundingClientRect();
        return {overflow:document.documentElement.scrollWidth>innerWidth, top:input.top, bottom:input.bottom, left:input.left, right:input.right, height:root.height}; })()`);
      expect(box.overflow).toBe(false);
      expect(box.top).toBeGreaterThanOrEqual(insets.top);
      expect(box.bottom).toBeLessThanOrEqual(height - insets.bottom);
      expect(box.left).toBeGreaterThanOrEqual(insets.left);
      expect(box.right).toBeLessThanOrEqual(width - insets.right);
      const shot = await request("Page.captureScreenshot", { format: "png" });
      writeFileSync(`${logPath}.web-app-${width}.png`, Buffer.from(shot.data, "base64"));
    }
    await evaluate("document.querySelector('textarea[aria-label^=\"Message\"]').focus()");
    await request("Input.insertText", { text: userText });
    await request("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await request("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    const settled = await runControlOmb(["wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "25", "--url", url]) as { status: string };
    expect(settled.status).toBe("settled");
    const bubble = (side: "user" | "bot", content: string) => `[...document.querySelectorAll('[data-look="${side}-bubble"]')].find(el => el.textContent.includes(${JSON.stringify(content)}))`;
    const userBubble = bubble("user", userText);
    const botBubble = bubble("bot", botText);
    await expect.poll(() => evaluate(`Boolean(${userBubble}) && Boolean(${botBubble})`), { timeout: 15_000 }).toBe(true);
    await request("Page.reload");
    await expect.poll(() => evaluate(`Boolean(${userBubble}) && Boolean(${botBubble})`), { timeout: 15_000 }).toBe(true);
    const messages = await fetch(`${url}/api/threads/${bot.activeTaskId}/messages?limit=50`).then(r => r.json());
    expect(messages.messages.filter((message: { role: string; text: string }) => message.role === "user" && message.text === userText)).toHaveLength(1);
    await request("Emulation.setSafeAreaInsetsOverride", { insets: { top: 44, bottom: 34, left: 0, right: 0 } });
    const bubbleLayouts = [];
    for (const [width, colorScheme] of [[320, "light"], [390, "dark"]] as const) {
      await request("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: colorScheme }] });
      await request("Emulation.setDeviceMetricsOverride", { width, height: 844, deviceScaleFactor: 1, mobile: true });
      const layout = await evaluate(`[${userBubble}, ${botBubble}].map(bubble => {
        const row = bubble.closest('[data-message-row]').getBoundingClientRect();
        const box = bubble.getBoundingClientRect();
        const text = bubble.querySelector('.chat-text, .chat-md p');
        const range = document.createRange();
        range.selectNodeContents(text);
        const firstLineFill = range.getClientRects()[0].width / text.getBoundingClientRect().width;
        return {
          width: box.width, rowWidth: row.width, startGap: box.left - row.left, endGap: row.right - box.right,
          wrapStyle: getComputedStyle(text).textWrapStyle, firstLineFill,
        };
      })`);
      bubbleLayouts.push({ width, layout });
      const [user, bot] = layout;
      expect(user.width / user.rowWidth, `user bubble at ${width}px`).toBeGreaterThanOrEqual(0.85);
      expect(bot.width / bot.rowWidth, `bot bubble at ${width}px`).toBeGreaterThanOrEqual(0.85);
      expect(user.endGap).toBeCloseTo(0);
      expect(bot.startGap).toBeCloseTo(0);
      expect(user.startGap).toBeGreaterThan(0);
      expect(bot.endGap).toBeGreaterThan(0);
      for (const row of [user, bot]) {
        expect(row.wrapStyle).toBe("auto");
        expect(row.firstLineFill).toBeGreaterThanOrEqual(0.9);
      }
      const shot = await request("Page.captureScreenshot", { format: "png" });
      writeFileSync(`${logPath}.bubbles-${width}.png`, Buffer.from(shot.data, "base64"));
    }
    const shortUserText = "谢谢。";
    await runControlOmb(["send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", shortUserText, "--url", url]);
    await runControlOmb(["wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "25", "--url", url]);
    const shortUserBubble = bubble("user", shortUserText);
    const shortBotBubble = bubble("bot", shortBotText);
    await expect.poll(() => evaluate(`Boolean(${shortUserBubble}) && Boolean(${shortBotBubble})`), { timeout: 15_000 }).toBe(true);
    const shortWidths = await evaluate(`[${shortUserBubble}, ${shortBotBubble}].map(bubble => bubble.getBoundingClientRect().width)`);
    for (const width of shortWidths) expect(width).toBeLessThan(100);

    const userActions = `(${userBubble}).parentElement.querySelector('[data-testid="message-actions"]')`;
    const tap = async (target: string) => {
      const point = await evaluate(`(async () => {
        const target = ${target};
        target.scrollIntoView({ block: 'center', behavior: 'instant' });
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const box = target.getBoundingClientRect();
        const x = box.left + box.width / 2;
        const y = [0.5, 0.75, 0.25].map(fraction => box.top + box.height * fraction)
          .find(y => target.contains(document.elementFromPoint(x, y)));
        return y === undefined ? null : { x, y };
      })()`);
      expect(point, "visible tap target").not.toBeNull();
      await request("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
      await request("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    };
    await tap(userBubble);
    await expect.poll(() => evaluate(`(${userActions}).dataset.shown`)).toBe("true");
    expect(await evaluate(`(${userBubble}).getBoundingClientRect().width`)).toBeCloseTo(bubbleLayouts.at(-1)!.layout[0].width);
    await tap(`(${userActions}).querySelector('button[aria-haspopup="menu"]')`);
    await expect.poll(() => evaluate(`Boolean((${userActions}).querySelector('[role="menu"]'))`)).toBe(true);
    expect(await evaluate("caches.keys()" )).toEqual([]);
    expect(await evaluate("navigator.serviceWorker.getRegistrations().then(items=>items.length)")).toBe(0);
    writeFileSync(`${logPath}.web-app.json`, JSON.stringify({ installability, bubbleLayouts, platform: process.platform }, null, 2));
    console.log(`Web app evidence: ${logPath}.web-app.json`);
  } finally {
    cdp?.close();
    if (chrome) await waitForExit(chrome, { signal: "SIGTERM" });
    await fixture?.close();
  }
}, 660_000);
