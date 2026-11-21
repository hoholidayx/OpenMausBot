import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MOBILE_BOOTSTRAP_PATH, type MobileBootstrap } from "../packages/phone-protocol/src/mobile-v1.ts";
import type { SignedInSessionResponse } from "../packages/phone-protocol/src/responses.ts";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-omb.ts";
import { VisibleSet } from "./bot-visibility.ts";
import { requiredScope } from "./request-auth.ts";
import { mobileBootstrap } from "./routes/mobile.ts";
import { prepareMobileFixture } from "./testing/mobile-api-fixture.ts";

const example = JSON.parse(readFileSync(new URL("../packages/phone-protocol/fixtures/mobile-v1/identity.json", import.meta.url), "utf8"));
const partner = { id: "a", name: "A", color: "purple" as const, threadId: "private", tasks: [{ threadId: "private", createdAt: 1 }] };
const viewer = { kind: "member" as const, email: "a@example.test" };

describe("mobile v1 projection", () => {
  it("keeps list order, omits hidden partners and limits avatars to stored images", () => {
    const second = { ...partner, id: "b", threadId: "b-chat", avatarUrl: "/api/attachments/face.png" };
    const bots = [second, { ...partner, avatarUrl: "https://example.test/face.png" }, { ...partner, id: "archived", hidden: true },
      { ...partner, id: "sidebar", sidebarHidden: true }, { ...partner, id: "owner", visibility: "admins" }];
    const result = mobileBootstrap(bots, new VisibleSet(bots, [], viewer));
    expect(result.bots.map((bot) => [bot.id, bot.avatarUrl])).toEqual([["b", second.avatarUrl], ["a", null]]);
  });

  it("returns a visible direct thread or null, and accepts an empty list", () => {
    const view = (tasks: typeof partner.tasks) => {
      const bot = { ...partner, tasks };
      const visible = new VisibleSet([bot], [], viewer, undefined, { person: "a", of: (id) => id === "private" ? "member:b" : "team" });
      return mobileBootstrap([bot], visible).bots[0].selectedThreadId;
    };
    expect(view(partner.tasks)).toBeNull();
    expect(view([...partner.tasks, { threadId: "shared", createdAt: 2 }])).toBe("shared");
    expect(mobileBootstrap([], new VisibleSet([], [], viewer))).toEqual({ version: 1, bots: [] });
  });

  it("grants client scope only to the exact read operation", () => {
    expect(requiredScope("GET", MOBILE_BOOTSTRAP_PATH)).toBe("client");
    expect(requiredScope("POST", MOBILE_BOOTSTRAP_PATH)).toBe("admin");
    expect(requiredScope("GET", MOBILE_BOOTSTRAP_PATH + "/extra")).toBe("admin");
  });
});

describe("mobile v1 on an isolated self-hosted server", () => {
  let fixture: VerificationServer;
  beforeAll(async () => { fixture = await launchVerificationServer(); });
  afterAll(async () => { await fixture?.close(); });

  it("pairs a member, projects the legacy list, and enforces revocation", async () => {
    const seed = await prepareMobileFixture(fixture);
    const origin = fixture.info.url;
    const remote = { "x-forwarded-proto": "https" };
    const read = (path: string, identity: Record<string, string> = {}) => fetch(origin + path, { headers: { ...remote, ...identity } });
    expect((await read(MOBILE_BOOTSTRAP_PATH)).status).toBe(403);
    const local = await (await fetch(origin + "/api/auth/session")).json();
    expect(local).toMatchObject({ kind: "loopback" });
    expect(local).not.toHaveProperty("mobileApiVersions");
    expect((await fetch(origin + MOBILE_BOOTSTRAP_PATH)).status).toBe(403);
    const pair = () => fetch(origin + "/api/auth/pair", {
      method: "POST", headers: { ...remote, "content-type": "application/json" },
      body: JSON.stringify({ code: seed.code, label: "Novia fixture", attemptId: "mobile-v1-retry", cookie: true }),
    });
    const paired = await pair();
    expect(paired.status).toBe(200);
    const cookie = paired.headers.getSetCookie()[0].split(";")[0];
    const retry = await pair();
    expect(retry.status).toBe(200);
    expect(retry.headers.getSetCookie()[0].split(";")[0] === cookie).toBe(true);
    const bearer = { authorization: "Bearer " + cookie.slice(cookie.indexOf("=") + 1) };
    const session = await (await read("/api/auth/session", bearer)).json() as SignedInSessionResponse;
    expect(session).toMatchObject({ ...example.session, id: session.id, expiresAt: session.expiresAt, environmentId: session.environmentId });
    expect(await (await read("/api/auth/session", { cookie })).json()).toMatchObject({ id: session.id, via: "cookie", scopes: ["client"] });
    const response = await read(MOBILE_BOOTSTRAP_PATH, bearer);
    expect(response.status).toBe(200);
    const summary = await response.json() as MobileBootstrap;
    const old = await (await read("/api/bots?messages=0", bearer)).json() as { bots: { id: string; hidden?: boolean; sidebarHidden?: boolean }[] };
    expect(summary.bots.map((bot) => bot.id)).toEqual(old.bots.filter((bot) => !bot.hidden && !bot.sidebarHidden).map((bot) => bot.id));
    expect(Object.keys(summary).sort()).toEqual(["bots", "version"]);
    expect(summary.version).toBe(example.bootstrap.version);
    expect(summary.bots.find((bot) => bot.id === seed.visible.id)).toEqual({
      ...example.bootstrap.bots[0], id: seed.visible.id, selectedThreadId: seed.visible.threadId,
    });
    expect(summary.bots.some((bot) => bot.id === seed.hidden.id || bot.selectedThreadId === seed.hidden.threadId)).toBe(false);
    expect(await (await read(MOBILE_BOOTSTRAP_PATH, { cookie })).json()).toEqual(summary);
    await seed.revoke(session.id);
    expect((await read(MOBILE_BOOTSTRAP_PATH, bearer)).status).toBe(401);
    expect((await read(MOBILE_BOOTSTRAP_PATH, { cookie })).status).toBe(401);
  });
});
