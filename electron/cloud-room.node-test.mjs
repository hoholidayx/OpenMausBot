import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";

import { cloudPlanSnapshot, createCloudAccountClient } from "./cloud-account.mjs";

// The room card's data (the session's `cloud.room`), against a fake Admin.
const accessToken = `omc_${"T".repeat(43)}`;
const NOW = 1_800_000_000_000;
const paid = { plan: "pro", tier: "pro", status: "active", expiresAt: NOW + 30 * 86400_000, version: 1 };
const usage = { tier: "pro", resetsAt: NOW + 86400_000, meters: [], upgrades: [{ tier: "max", amount: 9900 }] };
const room = { id: "4f1d6c2e-room", cause: { kind: "memory", waits: 3, waitMinutes: 6, stopped: 1 },
  plan: { tier: "max", amount: 9900, memoryMb: 8192, fromMemoryMb: 4096, diskGb: 100, fromDiskGb: 100 } };

/** A fake Admin: the session's `cloud` is `f.cloud`. */
async function admin(t) {
  const f = { requests: [], cloud: { state: "ready", origin: "https://omb-u-1a2b3c4d5e6f.fly.dev", pairingAvailable: true, usage, room: { ...room, extra: "dropped" } } };
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    f.requests.push({ route: req.url, method: req.method, body: body ? JSON.parse(body) : undefined });
    const send = ([status, data]) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    if (req.headers.authorization !== `Bearer ${accessToken}`) return send([401, { error: "invalid_token" }]);
    if (req.url === "/api/cloud/desktop/session") return send([200, { cloudContractVersion: 1, expiresAt: NOW + 86400_000, device: { id: "device-1" },
      account: { id: "acct-1", email: "person@example.test" }, entitlement: paid, cloud: f.cloud }]);
    send([404, { error: "not_found" }]);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const saved = { origin, token: accessToken, expiresAt: NOW + 86400_000, device: { id: "device-1" }, account: { id: "acct-1", email: "person@example.test" } };
  f.client = createCloudAccountClient({ origin, fixture: true, deviceName: "Fixture computer", platform: "darwin", appVersion: "0.1.fixture", now: () => NOW,
    store: { read: async () => saved, write: async () => {} }, openBrowser: async () => {}, setTimer: () => 1, clearTimer: () => {} });
  t.after(async () => { f.client.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return f;
}

test("the session's room reaches the state and the Cloud page's snapshot, checked, and only beside the usage it belongs to", async t => {
  const f = await admin(t);
  await f.client.start();
  const reading = { id: room.id, cause: room.cause };
  assert.deepEqual(f.client.state().room, reading);
  assert.deepEqual(cloudPlanSnapshot(f.client.state()).room, reading);
  const disk = { id: "disk-1", cause: { kind: "disk", usedGb: 87.5, capGb: 100 } };
  f.cloud = { ...f.cloud, room: { ...disk, tip: true } };
  assert.deepEqual((await f.client.refresh()).room, disk);
  f.cloud = { ...f.cloud, room: { ...room, cause: { ...room.cause, waits: -1 } } };
  assert.equal((await f.client.refresh()).room, undefined);
  f.cloud = { state: "ready", origin: f.cloud.origin, pairingAvailable: true, room };
  assert.equal((await f.client.refresh()).room, undefined);
});
