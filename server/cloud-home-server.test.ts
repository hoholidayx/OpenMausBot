import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";

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

it("refuses retired Cloud sign-in without consuming a self-hosted pairing code", async () => {
  const fixture = await launchVerificationServer();
  const { url } = fixture.info;
  const post = (path: string, body: object) => fetch(`${url}${path}`, {
    method: "POST",
    headers: { origin: url, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  try {
    const offer = await post("/api/auth/pairing", { scopes: ["client"] });
    expect(offer.status).toBe(200);
    const { code } = await offer.json() as { code: string };
    const input = { code, cookie: true, label: "Paired browser", attemptId: "selfhost-pairing-check" };
    const retired = await post("/api/auth/pair", { ...input, browser: true, preview: true });
    expect(retired.status).toBe(400);
    expect(retired.headers.get("set-cookie")).toBeNull();
    const paired = await post("/api/auth/pair", input);
    expect(paired.status).toBe(200);
    expect(paired.headers.get("set-cookie")).toContain("HttpOnly");
    const { session } = await paired.json() as { session: { id: string } };
    expect(session).toMatchObject({ label: "Paired browser", scopes: ["client"] });
    const repeated = await post("/api/auth/pair", input);
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toMatchObject({ session: { id: session.id } });
  } finally {
    await fixture.close();
  }
});

it("creates local bots without hosted ownership or sharing fields", async () => {
  const fixture = await launchVerificationServer();
  try {
    const { url } = fixture.info;
    const response = await fetch(`${url}/api/bots`, {
      method: "POST", headers: { origin: url, "content-type": "application/json" },
      body: JSON.stringify({ name: "Plain" }),
    });
    expect(response.status).toBe(201);
    const { bot } = await response.json() as { bot: Record<string, unknown> };
    expect(bot).not.toHaveProperty("access");
    expect(bot).not.toHaveProperty("visibility");
    expect(bot).not.toHaveProperty("createdBy");
  } finally {
    await fixture.close();
  }
});

it("keeps the retired hosted endpoints unavailable on a self-hosted server", async () => {
  const fixture = await launchVerificationServer();
  const { url } = fixture.info;
  try {
    const cases = [
      ["GET", "/api/sync", 404],
      ["GET", "/api/sync/folders", 404],
      ["GET", "/api/me", 404],
      ["PUT", "/api/me/welcome", 404],
      ["GET", "/api/team/people", 400],
      ["GET", "/api/team/people/p_abcdefghijklmnopqrstuv/picture", 404],
      ["PUT", "/api/team/reports-to", 400],
      ["PUT", "/api/bots/sample/reports-to", 400],
      ["POST", "/api/team/phone-pairing", 404],
    ] as const;
    for (const [method, path, expected] of cases) {
      const response = await fetch(url + path, { method, headers: { origin: url } });
      expect(response.status, path).toBe(expected);
    }
  } finally {
    await fixture.close();
  }
});
