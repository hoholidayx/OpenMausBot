import { describe, expect, it } from "vitest";

import type { Bot } from "@/state/store";
import { duplicateBotProfile, restrictedCopyRequest } from "./bot-duplicate";

describe("what a duplicated bot is created with", () => {
  it("asks for nothing when the source is not restricted", () => {
    expect(restrictedCopyRequest({})).toEqual({});
    expect(restrictedCopyRequest({ visibility: "everyone" })).toEqual({});
  });

  it("carries who may see the bot", () => {
    expect(restrictedCopyRequest({ visibility: "admins" })).toEqual({ visibility: "admins" });
    expect(restrictedCopyRequest({ visibility: { people: ["ada@example.test"] } })).toEqual({ visibility: { people: ["ada@example.test"] } });
  });

  it("carries the tool selection whenever the source has one, an empty one included", () => {
    const scope = { allow: ["native:read"], deny: ["native:bash"] };
    expect(restrictedCopyRequest({ toolScope: scope })).toEqual({ settings: { toolScope: scope } });
    expect(restrictedCopyRequest({ toolScope: { allow: [] } })).toEqual({ settings: { toolScope: { allow: [] } } });
  });

  it("carries every restriction together, in the one request that creates the copy", () => {
    const source = { visibility: "admins" as const, toolScope: { allow: [] }, helperModel: false };
    expect(JSON.parse(JSON.stringify(restrictedCopyRequest(source)))).toEqual({ visibility: "admins", settings: { toolScope: { allow: [] } } });
  });

  it("keeps a copy of a VPS bot on its source's own server, and on the default when the source has none", () => {
    const source = {
      id: "src", threadId: "t", name: "Rio", title: "", description: "", notifications: true, color: "green", unread: false,
      modelSelection: { instanceId: "codex", model: "default" }, messages: [],
      computer: "cloud", cloudBackend: "vps", autoStartVps: true, vpsAlias: "alpha-vps",
    } as Bot;
    expect(duplicateBotProfile(source)).toMatchObject({ name: "Rio copy", computer: "cloud", cloudBackend: "vps", autoStartVps: true, vpsAlias: "alpha-vps" });
    const { vpsAlias: _alias, ...onDefault } = source;
    expect(duplicateBotProfile(onDefault as Bot).vpsAlias).toBeUndefined();
  });

  it("a team's User gives a copy only who it is and how it looks: nothing an admin alone sets", () => {
    const source = { name: "Quotes", title: "Prices", description: "d", soul: "s", notifications: true, modelSelection: { instanceId: "claude", model: "m" },
      computer: "cloud", cloudBackend: "vps", autoStartVps: true, vpsAlias: "box", avatarUrl: "/a.png", visibility: { people: ["rui@acme.test"] }, toolScope: { allow: [] } } as unknown as Bot;
    expect(restrictedCopyRequest(source, true)).toEqual({});
    expect(Object.keys(duplicateBotProfile(source, true)).sort()).toEqual(["avatarCrop", "avatarFocusX", "avatarFocusY", "avatarUrl", "avatarZoom", "description", "modelSelection", "name", "notifications", "soul", "title"]);
    expect(duplicateBotProfile(source, true).name).toBe("Quotes copy");
    expect(Object.keys(duplicateBotProfile(source, false))).toEqual(expect.arrayContaining(["computer", "cloudBackend", "autoStartVps", "vpsAlias"]));
  });
});
