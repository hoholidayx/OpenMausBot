import { expect, it } from "vitest";
import { compactBudget, contextWindowFor, DEFAULT_CONTEXT_WINDOW } from "./context-budget.ts";

it("keeps compaction reachable below small model windows", () => {
  expect(compactBudget(8_000)).toBe(6_400);
  expect(compactBudget(2_000, 20_000)).toBe(1_800);
  expect(compactBudget(100_000, 0.7)).toBe(70_000);
});

it("rejects invalid window values and ignores invalid provider readings", () => {
  for (const value of [NaN, Infinity, 0, -1]) {
    expect(() => compactBudget(value)).toThrow();
    expect(contextWindowFor(undefined, undefined, value)).toBe(DEFAULT_CONTEXT_WINDOW);
  }
});
