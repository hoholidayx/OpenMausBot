import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { RoutineScheduleNote } from "./RoutineScheduleNote";
import { localDesktopPage } from "./onboarding/WelcomeGate";

vi.mock("./onboarding/WelcomeGate", () => ({ localDesktopPage: vi.fn() }));
afterEach(() => vi.unstubAllGlobals());

it.each([
  [true, false, "local"],
  [true, true, "server"],
  [false, false, "server"],
])("says where a routine runs (local page %s, companion %s)", (local, companion, place) => {
  vi.stubGlobal("window", { ogb: { remoteClient: { active: companion } } });
  vi.mocked(localDesktopPage).mockReturnValue(local);
  const html = renderToStaticMarkup(createElement(RoutineScheduleNote));
  expect(html).toContain(`data-routine-schedule-note="${place}"`);
  expect(html).not.toContain("<button");
});
