import { describe, expect, it } from "vitest";

import { withoutExpired } from "./memory-entries.ts";


const expired = [
  "- 2026-10-01 · Temporary deployment · until 2026-10-31",
  "  ```sh",
  "  deploy --temporary",
  "",
  "  ```",
  "  Remove this deployment after the deadline.",
];
const live = "- 2026-11-01 · Current deployment";

describe("whole memory entry boundaries", () => {
  it("removes an expired entry and all of its continuation lines", () => {
    const text = ["# Memory", ...expired, live, "  Keep this detail.", ""].join("\n");
    expect(withoutExpired(text, "2026-11-01")).toEqual({
      text: ["# Memory", live, "  Keep this detail.", ""].join("\n"),
      hidden: 1,
    });
  });

  it("counts expired entries rather than removed physical lines", () => {
    const second = ["- 2026-10-02 · Temporary endpoint · until 2026-10-30", "  endpoint.example"];
    expect(withoutExpired([...expired, ...second, live].join("\n"), "2026-11-01"))
      .toEqual({ text: live, hidden: 2 });
  });

  it("keeps an entry through its final day", () => {
    const text = [...expired, live].join("\n");
    expect(withoutExpired(text, "2026-10-31")).toEqual({ text, hidden: 0 });
  });

  it("keeps handwritten text outside the recognized entry", () => {
    const text = [expired[0], "## Manual notes", "keep this text", live].join("\n");
    expect(withoutExpired(text, "2026-11-01").text)
      .toBe(["## Manual notes", "keep this text", live].join("\n"));
  });
});
