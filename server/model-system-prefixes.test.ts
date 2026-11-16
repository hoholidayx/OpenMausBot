import { mkdtempSync } from "node:fs";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createModelSystemPrefixes } from "./model-system-prefixes.ts";
import { createModelSystemPrefixRoutes } from "./routes/model-system-prefixes.ts";
import { buildSystemPrompt, teamRosterPart } from "./system-prompt.ts";
import { removeTempDir } from "./testing/cleanup.ts";

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "omb-model-prefix-")); });
afterEach(() => removeTempDir(directory));

it("keys by connection and model, changes only the stable prompt and persists edits and removals", () => {
  const file = join(directory, "prefixes.json");
  const prefixes = createModelSystemPrefixes(file);
  const one = { instanceId: "one", driverKind: "openai-compat" };
  const two = { instanceId: "two", driverKind: "openai-compat" };
  const model = "vendor/model";
  const base = buildSystemPrompt("Identity.", "SOUL", [{ id: "files", label: "Files", text: "\nDynamic." }, teamRosterPart("Scout and Echo")]);
  expect(prefixes.apply(base, one, model)).toBe(base);

  prefixes.save(one.instanceId, model, "  Prefix one.\n第二行  ");
  prefixes.save(two.instanceId, model, "Prefix two.");
  expect(prefixes.apply(base, one, "Vendor/model")).toBe(base);
  expect(prefixes.apply(base, one, model, "Another model")).toBe(base);
  expect(prefixes.apply(base, { ...one, driverKind: "claudeAgent" }, model)).toBe(base);

  const saved = createModelSystemPrefixes(file);
  const prefix = "  Prefix one.\n第二行  \n\n";
  expect(saved.apply(base, one, model)).toEqual({
    sections: [{ id: "model-system-prefix", label: "Model system prefix", text: prefix, bytes: Buffer.byteLength(prefix) }, ...base.sections],
    text: prefix + base.text,
    stable: prefix + base.stable,
    volatile: base.volatile,
    roster: "\nScout and Echo",
  });
  expect(saved.apply(base, two, model).stable).toBe("Prefix two.\n\n" + base.stable);
  expect(() => saved.save(one.instanceId, model, "字".repeat(8_001))).toThrow("24,000 UTF-8 bytes");
  expect(saved.read(one.instanceId, model)).toBe("  Prefix one.\n第二行  ");
  saved.save(one.instanceId, model, "  ");
  expect(createModelSystemPrefixes(file).apply(base, one, model)).toBe(base);
});

it("lists only writable API connections and denies management by service callers", async () => {
  const prefixes = createModelSystemPrefixes(join(directory, "prefixes.json"));
  let readOnly = false;
  const route = createModelSystemPrefixRoutes({
    prefixes,
    connections: () => [
      { instanceId: "api", driverKind: "openai-compat", readOnly },
      { instanceId: "managed", driverKind: "openai-compat", readOnly: true },
      { instanceId: "cli", driverKind: "claudeAgent", readOnly: false },
    ],
  });
  const request = async (instanceId?: string, readBody?: () => Promise<unknown>, service = false) => {
    const url = new URL("http://localhost/api/model-system-prefixes");
    if (instanceId) url.search = new URLSearchParams({ instanceId, model: "vendor/model" }).toString();
    const req = new IncomingMessage(new Socket());
    req.headers["content-type"] = "application/json";
    const res = new ServerResponse(req);
    let result: unknown;
    await route({
      url, path: url.pathname, method: readBody ? "PUT" : "GET",
      auth: service ? { kind: "loopback", trust: "service", scopes: ["client"] } : { kind: "loopback", scopes: ["admin"] },
      req, res,
      json: (_res, status, value) => { result = { status, value }; },
      readBody: readBody ?? (async () => undefined),
    });
    return result;
  };
  expect(await request()).toEqual({ status: 200, value: { instances: ["api"] } });
  expect(await request("api", async () => ({ text: "Own prefix" }))).toEqual({ status: 200, value: { text: "Own prefix" } });
  expect(await request("api", undefined, true)).toMatchObject({ status: 403 });
  for (const instance of ["managed", "cli"]) {
    expect(await request(instance)).toMatchObject({ status: 403 });
    expect(await request(instance, async () => ({ text: "Denied" }))).toMatchObject({ status: 403 });
    expect(prefixes.read(instance, "vendor/model")).toBe("");
  }
  expect(await request("api", async () => {
    readOnly = true;
    return { text: "Now denied" };
  })).toMatchObject({ status: 403 });
  expect(prefixes.read("api", "vendor/model")).toBe("Own prefix");
});
