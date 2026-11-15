// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { InstanceInfo } from "@/state/store";
import { ModelSystemPrefixSettings } from "./ModelSystemPrefixSettings";

const fixture = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/store", () => ({ api: fixture.api }));

it("keeps separate model drafts across switches and retries, and clears saved text", async () => {
  const instance = {
    instanceId: "one",
    displayName: "Fixture connection",
    models: { default: "vendor/first", options: [
      { id: "vendor/first", label: "First" }, { id: "vendor/second", label: "Second" },
    ] },
  } as InstanceInfo;
  const stored = new Map([["vendor/first", "Saved first"], ["vendor/second", "Saved second"]]);
  let rejectSave = true;
  fixture.api.mockImplementation(async (path: string, options?: RequestInit) => {
    const { searchParams } = new URL(path, "http://localhost");
    expect(searchParams.get("instanceId")).toBe("one");
    const model = searchParams.get("model")!;
    if (options?.method === "PUT") {
      if (rejectSave) throw new Error("Synthetic save failure");
      stored.set(model, JSON.parse(String(options.body)).text);
    }
    return { text: stored.get(model) ?? "" };
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const textarea = () => container.querySelector("textarea")!;
  const button = (label: string) => [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === label)!;
  const click = (label: string) => act(async () => button(label).click());
  const select = (model: string) => act(async () => {
    const field = container.querySelector("select")!;
    field.value = model;
    field.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const edit = (field: HTMLInputElement | HTMLTextAreaElement, value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });

  try {
    await act(async () => root.render(createElement(ModelSystemPrefixSettings, { instance })));
    expect(container.querySelector("textarea")).toBeNull();
    expect(fixture.api).not.toHaveBeenCalled();
    await click("Model system prefix");
    expect(textarea().value).toBe("Saved first");
    await edit(textarea(), "Unsaved first");
    await select("model:vendor/second");
    expect(textarea().value).toBe("Saved second");
    await select("model:vendor/first");
    expect(textarea().value).toBe("Unsaved first");
    await click("Save");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Your edit is still here");
    expect(textarea().value).toBe("Unsaved first");
    rejectSave = false;
    await edit(textarea(), "");
    await click("Save");
    expect(stored.get("vendor/first")).toBe("");

    await select("custom");
    await edit(container.querySelector("input")!, "other/exact-model");
    await edit(textarea(), "Manual model prefix");
    await click("Save");
    expect(stored.get("other/exact-model")).toBe("Manual model prefix");
    expect(stored.get("vendor/second")).toBe("Saved second");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
