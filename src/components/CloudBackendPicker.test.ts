import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { CloudBackendPicker } from "./CloudBackendPicker";

it("offers a self-hosted VPS for a saved Boat selection", () => {
  const onChange = vi.fn();
  const picker = CloudBackendPicker({ value: "box", onChange });
  const html = renderToStaticMarkup(picker);
  expect(html).toContain("Self-hosted VPS");
  expect(html).not.toContain("Boat");
  const button = picker.props.children[2] as ReactElement<{ onClick(): void }>;
  button.props.onClick();
  expect(onChange).toHaveBeenCalledWith("vps");
});

it("shows the SSH details when a VPS is selected", () => {
  const html = renderToStaticMarkup(createElement(CloudBackendPicker, { value: "vps", compact: true, onChange: vi.fn() }));
  expect(html).toContain("Your own server, connected over SSH.");
  expect(html).not.toContain("<button");
});
