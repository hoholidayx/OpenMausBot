import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

import { launchCloudSendFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { availableTools } from "./drivers/agents-catalog.ts";
import { catalogProfileFromEnv } from "./drivers/agents-catalog-profile.ts";
import { LEGACY_MEMORY_DISABLED } from "./legacy-memory.ts";
import { AGENTS_ENV_HEADER, OWN_MCP_HTTP_PATH } from "./routes/own-mcp-http-path.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

it(
  "disables workspace memory without losing the conversation, department rules or saved notes",
  async () => {
    const fixture = await launchCloudSendFixture({
      onePasswordToken: "ops_fake-legacy-memory",
      team: {
        id: "legacy-memory-test",
        name: "Legacy Memory",
        engine: `process.env.FAKE_CLAUDE_DUMP = process.env.FAKE_CLAUDE_FIXTURE_DIR + "/dump.json";
process.env.FAKE_CLAUDE_EXIT_AFTER_TURN = "1";`,
      },
    });
    try {
      const team = fixture.team!;
      const owner = (await team.pair({ email: "owner@example.test", role: "owner" })).token!;
      const member = (await team.pair({ email: "member@example.test", role: "member" })).token!;
      const settings = { autoRecall: true, roomMemoryCapture: true };
      const section = "Release";
      const rules = "Run the project's fixture smoke test before publishing.";
      const shared = "Snapshot folder belongs to the cobalt project.";
      const note = "The lease identifier is speckled-garnet.";
      const privateNote = "Private preference amber-binder.";
      const profile = "Background preference violet-ledger.";
      const topic = "Pilot schedule for indigo kelp is Wednesday.";
      const previousRequest = "First release chat message about the indigo kelp pilot schedule.";
      const dumpPath = join(team.home, "dump.json");
      const call = async (
        token: string,
        method: string,
        path: string,
        body?: unknown,
        status = 200,
      ) => {
        const answer = await team.as(token, method, path, body);
        expect(answer.status, `${method} ${path}: ${JSON.stringify(answer.body)}`).toBe(status);
        return answer.body;
      };
      const { bot } = await call(
        owner,
        "POST",
        "/api/bots",
        { name: "Release Work", section, visibility: "everyone" },
        201,
      );
      const base = `/api/bots/${bot.id}`;
      await call(owner, "PUT", "/api/config", { features: settings });
      await call(owner, "PUT", `/api/section-context?section=${section}`, { text: rules });
      await call(
        owner,
        "POST",
        `/api/team-memory?section=${section}`,
        { kind: "term", name: "Snapshots", detail: shared },
        201,
      );
      await call(owner, "PUT", `${base}/memory/file`, { path: "MEMORY.md", text: note });
      await call(member, "PUT", `${base}/memory/mine/file`, {
        path: "MEMORY.md",
        text: privateNote,
      });
      await call(member, "PUT", `${base}/memory/mine/file`, {
        path: "memory/indigo-kelp.md",
        text: topic,
      });
      await call(member, "PUT", "/api/me", { aboutMe: profile });
      const { task } = await call(
        member,
        "POST",
        `${base}/tasks`,
        { title: "Release conversation" },
        201,
      );
      const { threadId } = task;
      const transcript = () => call(member, "GET", `/api/threads/${threadId}/messages?limit=100`);
      const turn = async (message: string) => {
        rmSync(dumpPath, { force: true });
        const count = (await transcript()).messages.filter(
          (row: { role: string; kind?: string }) => row.role === "bot" && row.kind === "text",
        ).length;
        await call(member, "POST", `${base}/messages`, { text: message, threadId }, 202);
        await expect
          .poll(
            async () =>
              (await transcript()).messages.filter(
                (row: { role: string; kind?: string }) => row.role === "bot" && row.kind === "text",
              ).length,
            { timeout: 25_000 },
          )
          .toBeGreaterThan(count);
        return JSON.parse(readFileSync(dumpPath, "utf8"));
      };
      const on = await turn(previousRequest);
      for (const text of [rules, shared, note, privateNote, profile])
        expect(on.systemPrompt).toContain(text);
      expect(JSON.stringify(on.prompt)).toContain(topic);
      await expect
        .poll(async () => (await call(member, "GET", `${base}/memory/mine`)).logs.length)
        .toBeGreaterThan(0);
      const before = await call(member, "GET", `${base}/memory/mine`);

      await team.relaunch({ OMB_LEGACY_MEMORY: undefined });
      const off = await turn("Remind me about the indigo kelp pilot schedule.");
      for (const text of [shared, note, privateNote, profile])
        expect(off.systemPrompt).not.toContain(text);
      expect(off.systemPrompt).toContain(rules);
      expect(JSON.stringify(off.prompt)).toContain(previousRequest);
      expect(JSON.stringify(off.prompt)).not.toContain(topic);
      expect(off.argv).not.toContain("--resume");
      const blockedTools = ["memory_update", "memory_log", "propose_team_memory", "session_search"];
      const toolNames = availableTools(
        catalogProfileFromEnv(off.mcpConfig.mcpServers.agents.env),
      ).map((tool) => tool.name);
      expect(toolNames).toContain("coordinate_bots");
      for (const name of blockedTools) expect(toolNames).not.toContain(name);

      const token = await team.capability(bot.id, threadId);
      const catalog = await fetch(`${team.base}${OWN_MCP_HTTP_PATH}agents`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          [AGENTS_ENV_HEADER]: Buffer.from(JSON.stringify({ OMB_LEGACY_MEMORY_ENABLED: "1" })).toString("base64url"),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(catalog.status).toBe(200);
      const { result } = await catalog.json() as { result: { tools: Array<{ name: string }> } };
      const httpToolNames = result.tools.map((tool) => tool.name);
      expect(httpToolNames).toContain("coordinate_bots");
      for (const name of blockedTools) expect(httpToolNames).not.toContain(name);

      for (const path of [
        "memory",
        "memory/log",
        "team-memory",
        "session-search",
        "session-read",
      ]) {
        const response = await fetch(`${team.base}/api/internal/${path}`, {
          method: path.startsWith("session-") ? "GET" : "POST",
          headers: { authorization: `Bearer ${token}` },
        });
        expect(response.status, path).toBe(403);
        expect(await response.json(), path).toMatchObject({ error: LEGACY_MEMORY_DISABLED });
      }
      await call(
        owner,
        "POST",
        `/api/team-memory?section=${section}`,
        { kind: "term", name: "Disabled", detail: "Should not save." },
        409,
      );
      await call(
        member,
        "PUT",
        `${base}/memory/mine/file`,
        { path: "MEMORY.md", text: "Should not save." },
        409,
      );
      await call(member, "POST", `${base}/memory/team`, {}, 409);
      await call(owner, "POST", `${base}/memory/tidy`, undefined, 409);
      expect((await call(owner, "GET", "/api/config")).features).toMatchObject({
        legacyMemory: false,
        autoRecall: false,
        roomMemoryCapture: false,
      });
      expect((await call(member, "GET", "/api/config")).features.legacyMemory).toBe(false);
      expect((await call(owner, "GET", `/api/team-memory?section=${section}`)).loadedIds).toEqual(
        [],
      );
      expect((await call(owner, "GET", `${base}/memory/upkeep`)).enabled).toBe(false);
      expect((await call(member, "GET", `${base}/memory/mine/file?path=MEMORY.md`)).text).toBe(
        privateNote,
      );
      expect((await call(member, "GET", `${base}/memory/mine`)).logs).toEqual(before.logs);
    } finally {
      await fixture.close();
    }
  },
  hostTimeout(120_000),
);
