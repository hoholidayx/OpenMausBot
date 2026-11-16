import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const server = fileURLToPath(new URL("./index.ts", import.meta.url));

it.each([
  { OMB_CLOUD_ROLE: "home" },
  { OMB_CLOUD_ROLE: "team" },
  { OMB_ADMIN_MEMBERSHIP: "portal" },
])("rejects retired hosted workspace configuration before opening its data directory (%j)", (settings) => {
  const root = mkdtempSync(join(tmpdir(), "omb-retired-workspace-"));
  const dataDir = join(root, "workspace");
  try {
    const child = spawnSync(process.execPath, ["--experimental-strip-types", server], {
      env: { ...process.env, OMB_DATA_DIR: dataDir, ...settings },
      timeout: 15_000,
      encoding: "utf8",
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(1);
    expect(child.stderr).toContain("Hosted MausBot workspaces are no longer supported");
    expect(existsSync(dataDir)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
