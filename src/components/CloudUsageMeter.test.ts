import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { CloudUsage } from "../../electron/cloud-home.mjs";
import { CloudUsageCardView, CloudUsageSettingsView } from "./CloudUsageMeter";

const usage: CloudUsage = {
  tier: "pro", resetsAt: Date.UTC(2026, 10, 1),
  meters: [{ kind: "computerHours", used: 285, max: 300 }, { kind: "storage", used: 41.2, max: 100 }],
};

it("shows usage and the reset date without advertising a different plan", () => {
  const html = renderToStaticMarkup(createElement(CloudUsageSettingsView, { usage }));
  expect(html).toContain("285 of 300 hours");
  expect(html).toContain("41.2 of 100 GB");
  expect(html).toContain("Resets on Nov 1.");
  expect(html).not.toMatch(/Upgrade|\$99/);
});

it("keeps the limit warning, dismiss button and usage link", () => {
  const html = renderToStaticMarkup(createElement(CloudUsageCardView, {
    usage, meters: [usage.meters[0]!], band: "near", onHide: () => {}, onSeeAll: () => {},
  }));
  expect(html).toContain('role="progressbar"');
  expect(html).toContain("See all usage");
  expect(html).toContain("Hide for now");
  expect(html).not.toContain("Upgrade");
});
