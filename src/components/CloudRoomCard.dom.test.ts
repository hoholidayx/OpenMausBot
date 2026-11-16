// @vitest-environment happy-dom
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudPlanBridge, CloudPlanSnapshot } from "../../electron/cloud-account.mjs";
import type { CloudRoom, CloudUsage } from "../../electron/cloud-home.mjs";
import { setLocale } from "@/lib/i18n";

const store = vi.hoisted(() => ({ bots: [] as Array<{ id: string; busy?: boolean }> }));
vi.mock("@/state/store", async original => ({ ...await original<typeof import("@/state/store")>(),
  useStore: () => ({ state: { bots: store.bots, config: { cloudHome: true } }, dispatch: vi.fn() }) }));
import { CloudRoomCard } from "./CloudRoomCard";

// The room card on the person's own Cloud, rendered as the sidebar renders it, against a bridge that answers as main does.
const usage: CloudUsage = { tier: "starter", resetsAt: Date.UTC(2026, 10, 1), meters: [{ kind: "storage", used: 2, max: 10 }] };
const memory: CloudRoom = { id: "memory-1", cause: { kind: "memory", waits: 3, waitMinutes: 6, stopped: 0 } };
let container: HTMLDivElement, root: Root, snapshot: CloudPlanSnapshot;
function bridge(): CloudPlanBridge {
  return { state: vi.fn(async () => snapshot), manage: vi.fn(async () => {}) };
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLocale("en");
  globalThis.localStorage?.clear();
  store.bots = [{ id: "chief" }];
  snapshot = { status: "paid", tier: "starter", usage, room: memory };
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); document.body.innerHTML = ""; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };
const show = async (plan: CloudPlanBridge) => { vi.stubGlobal("window", Object.assign(window, { ogb: { cloudPlan: plan } })); await act(async () => { root.render(createElement(CloudRoomCard)); }); await settle(); };
const card = () => document.querySelector<HTMLElement>("[data-cloud-room-card]");
const text = () => card()?.textContent ?? "";
const button = (label: string) => [...document.querySelectorAll("button")].find(item => item.textContent === label);
const click = async (target: Element | null | undefined) => { expect(target).toBeTruthy(); await act(async () => { (target as HTMLElement).click(); }); await settle(); };

describe("the room card", () => {



  it("waits while any bot is working, and dismissing the notice hides it in this browser", async () => {
    store.bots = [{ id: "chief", busy: true }];
    const plan = bridge();
    await show(plan);
    expect(card()).toBeNull();
    store.bots = [{ id: "chief" }];
    await act(async () => { root.render(createElement(CloudRoomCard)); });
    await settle();
    expect(card()).not.toBeNull();
    await click(button("Got it"));
    expect(localStorage.getItem("openmausbot.roomCard.hidden.v1")).toBe(memory.id);
    expect(card()).toBeNull();
  });

  it("shows a disk tip and yields to an active usage notice", async () => {
    const plan = bridge();
    snapshot = { status: "paid", tier: "max", usage: { ...usage, tier: "max" }, room: { id: "tip-1", cause: { kind: "disk", usedGb: 87.5, capGb: 100 } } };
    await show(plan);
    expect(card()?.getAttribute("data-cloud-room-card")).toBe("tip");
    expect(text()).toBe("This Cloud is almost out of space87.5 GB of 100 GB used.Free up space by deleting files and folders you no longer need.Got it");
    expect(button("Upgrade")).toBeUndefined();
    await click(button("Got it"));
    await act(async () => root.unmount()); root = createRoot(container);
    snapshot = { status: "paid", tier: "starter", usage: { ...usage, meters: [{ kind: "computerHours", used: 95, max: 100 }] }, room: { ...memory, id: "offer-2" } };
    await show(bridge());
    expect(card()).toBeNull();
  });
});
