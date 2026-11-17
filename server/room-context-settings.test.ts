import { describe, expect, it } from "vitest";
import { z } from "zod";

import { parseConfigPatch, parseStoredConfig } from "./config.ts";
import { roomContextSettings } from "./room-context-settings.ts";

describe("room context settings", () => {
  it("carries roomCompactAt with the bounds it had in config.ts", () => {
    const shape = z.object(roomContextSettings);
    expect(shape.parse({ roomCompactAt: 0.9 })).toEqual({ roomCompactAt: 0.9 });
    expect(shape.parse({ roomCompactAt: 10_000_000 })).toEqual({ roomCompactAt: 10_000_000 });
    for (const value of [0, -0.5, 10_000_001, "0.9"]) expect(() => shape.parse({ roomCompactAt: value })).toThrow();
    expect(shape.parse({})).toEqual({});
  });

  it("is part of config.json's context group, stored and patched", () => {
    const context = { autoCompact: true, compactAt: 0.7, roomCompactAt: 0.5 };
    expect(parseStoredConfig({ context: { ...context, roomSessions: false } })).toEqual({ context });
    expect(parseConfigPatch({ context: { roomCompactAt: 0.6, roomSessions: true } })).toEqual({ context: { roomCompactAt: 0.6 } });
    expect(() => parseConfigPatch({ context: { roomCompactAt: 0 } })).toThrow();
  });
});
