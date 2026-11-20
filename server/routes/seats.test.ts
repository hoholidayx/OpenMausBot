import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { json, readBody } from "../harness/http.ts";
import { requiredScope, serviceAllowed } from "../request-auth.ts";
import { createSeatsRoutes } from "./seats.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

describe("seat count", () => {
  it("answers with the number alone, to an admin and to the server's own loopback, never to a chat-only session", async () => {
    const routes = [createSeatsRoutes()];
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const handled = await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth: { kind: "loopback", scopes: ["admin"] }, json, readBody });
      if (!handled) json(res, 404, {});
    });
    servers.push(server);
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const response = await fetch(`${base}/api/seats`);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ seats: 1 });
    expect(text).not.toContain("@");
    expect((await fetch(`${base}/api/seats`, { method: "POST" })).status).toBe(404);
    expect(requiredScope("GET", "/api/seats")).toBe("admin");
    expect(serviceAllowed("GET", "/api/seats")).toBe(true);
    expect(serviceAllowed("POST", "/api/seats")).toBe(false);
  });
});
