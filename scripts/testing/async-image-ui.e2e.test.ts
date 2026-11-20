import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { fixtureImageBridge, fixturePng } from "../../server/testing/image-bridge.ts";
import { launchVerificationServer, runControlOmb } from "../control-omb.ts";
import { agentBrowser, ensureUiBrowser, sessionEnv } from "./control-omb-ui.ts";
import { fixtureApi, mountPreview } from "./preview-fixture.ts";

it.skipIf(process.env.OMB_UI_E2E !== "1")(
  "updates the original card in the renderer and opens and downloads the image on desktop and narrow screens",
  async () => {
    const browserTools = await ensureUiBrowser(process.env);
    const fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, { scripted: true });
    const { url, dataDir } = fixture.info;
    const png = process.env.OMB_UI_IMAGE_FIXTURE ? readFileSync(process.env.OMB_UI_IMAGE_FIXTURE) : fixturePng;
    const remote = await fixtureImageBridge(png);
    const preview = await mountPreview(fixture, {
      entry: "/scripts/testing/threads-preview.tsx",
      route: "/__image-chat.html",
      title: "Image chat",
      logLevel: "warn",
    });
    const env = sessionEnv({ home: dataDir, session: "img", chrome: browserTools.chrome });
    const browser = async (...args: string[]) => {
      try {
        return await agentBrowser(browserTools.binary, env, args);
      } catch (error) {
        throw new Error(
          args.slice(0, 2).join(" ") +
            ": " +
            String((await agentBrowser(browserTools.binary, env, ["snapshot"])).snapshot).slice(-1600),
          { cause: error },
        );
      }
    };
    const evalPage = async (js: string) => (await browser("eval", js)).result;
    const api = fixtureApi(url);
    const folder = process.env.OMB_UI_EVIDENCE_DIR;
    try {
      if (folder) mkdirSync(folder, { recursive: true });
      await api("PUT", "/api/config", { language: "en" });
      for (const bot of (await api("GET", "/api/bots")).bots)
        if (bot.defaultBot) await api("PATCH", "/api/bots/" + bot.id, { welcomed: true });
      await api("POST", "/api/mcp/servers", { name: "pictures", type: "http", url: remote.url, enabled: true });
      await api("PATCH", "/api/mcp/servers/pictures", { enabled: true });
      await api("PUT", "/api/config", { imageGen: { asyncMcp: "pictures" } });
      const { bot } = (await runControlOmb(["new-bot", "--name", "Image fixture", "--url", url])) as {
        bot: { id: string; activeTaskId: string };
      };
      const code = (await api("POST", "/api/auth/pairing", { scopes: ["client"] })).code;
      const token = (await api("POST", "/api/auth/pair", { code })).token;
      writeFileSync(
        join(dataDir, "room-plan.json"),
        JSON.stringify({
          [bot.id]: {
            steps: [{ tool: "generate_image_async", arguments: { prompt: "A lantern" } }],
            reply: "Queued your lantern.",
          },
        }),
      );
      await browser("open", preview.previewUrl);
      await expect.poll(() => evalPage("document.body.innerText"), { timeout: 60_000 }).toContain("Image fixture");
      await evalPage(
        'document.querySelector("textarea[aria-label=\\"Message Image fixture\\"]") || Array.from(document.querySelectorAll("button")).find(b=>b.textContent.trim()==="Image fixture")?.click(); true',
      );
      const sent = await fetch(url + "/api/bots/" + bot.id + "/messages", {
        method: "POST",
        headers: { origin: url, "content-type": "application/json", authorization: "Bearer " + token },
        body: JSON.stringify({ threadId: bot.activeTaskId, text: "Draw a lantern." }),
      });
      expect(sent.status).toBe(202);
      await expect
        .poll(() => evalPage("document.querySelector('[data-image-job] [role=status]')?.innerText"), {
          timeout: 25_000,
        })
        .toMatch(/queued|Generating/);
      remote.control.complete = true;
      await browser("wait", '[data-image-job="done"]');
      const open = '[role=button][aria-label^="Preview attached image"]';
      for (const [name, width, height] of [
        ["desktop", "1200", "900"],
        ["mobile", "390", "844"],
      ]) {
        await browser("set", "viewport", width, height);
        await browser("wait", open);
        await browser("focus", open);
        await browser("press", "Enter");
        await browser("wait", '[role="dialog"] a[download]');
        const bytes = await evalPage(
          "fetch(document.querySelector('[role=dialog] a[download]').href).then(r=>r.arrayBuffer()).then(b=>b.byteLength)",
        );
        expect(bytes).toBe(png.length);
        expect(await evalPage("document.documentElement.scrollWidth <= innerWidth + 1")).toBe(true);
        if (folder) await browser("screenshot", join(folder, name + "-preview.png"));
        await browser("press", "Escape");
        await expect.poll(() => evalPage("!!document.querySelector('[role=dialog] a[download]')")).toBe(false);
        if (folder) await browser("screenshot", join(folder, name + "-chat.png"));
      }
    } finally {
      await browser("close").catch(() => {});
      await preview.close();
      await fixture.close();
      await remote.close();
    }
  },
  150_000,
);
