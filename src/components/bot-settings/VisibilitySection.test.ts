import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { StoreProvider, type Bot } from "@/state/store";
import { visibilityMode, mixedRooms, VisibilitySection } from "./VisibilitySection";

const render = (target: Bot) => renderToStaticMarkup(createElement(StoreProvider, null, createElement(VisibilitySection, { bot: target })));

const bot = (visibility?: Bot["visibility"]) => ({ id: "b1", name: "Payroll", visibility } as unknown as Bot);

describe("bot visibility form", () => {
  it("maps existing email audiences to restricted device access", () => {
    expect(visibilityMode(undefined)).toBe("everyone");
    expect(visibilityMode("everyone")).toBe("everyone");
    expect(visibilityMode("admins")).toBe("admins");
    expect(visibilityMode({ people: ["ada@example.test"] })).toBe("admins");
  });

  it("names the rooms this bot shares with bots other people can see", () => {
    const bots = [
      { id: "b1", visibility: { people: ["Ada@example.test"] } },
      { id: "b2", visibility: undefined },
      { id: "b3", visibility: { people: ["ada@example.test"] } },
    ] as Array<Pick<Bot, "id" | "visibility">>;
    const groups = [
      { id: "g1", name: "Pay questions", memberIds: ["b1", "b2"] },
      { id: "g2", name: "HR desk", memberIds: ["b1", "b3"] },
      { id: "g3", name: "b1 ⇄ b2", memberIds: ["b1", "b2"], dm: true },
      { id: "g4", name: "Old severance room", memberIds: ["b2"], audienceFloor: "admins" as const },
    ];
    expect(mixedRooms(bots[0]!, groups, bots)).toEqual([{ id: "g1", name: "Pay questions" }]);
    expect(mixedRooms(bots[2]!, groups, bots)).toEqual([]);
    expect(mixedRooms(bots[1]!, groups, bots).map((room) => room.id)).toEqual(["g1", "g4"]);
  });

  it("shows a restricted audience without an email editor", () => {
    const people = render(bot({ people: ["ada@example.test"] }));
    expect(people).not.toContain("ada@example.test");
    expect(people).toMatch(/checked="" value="admins"/);
    expect(people).not.toContain("<textarea");
    const everyone = render(bot());
    expect(everyone).toMatch(/checked="" value="everyone"/);
    expect(everyone).not.toContain("<textarea");
  });
});
