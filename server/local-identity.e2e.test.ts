import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";

it("exposes one local owner across paired devices and closes the email sign-in path", async () => {
  const fixture = await launchVerificationServer();
  const api = async <T = unknown>(path: string, body?: object, token?: string, method = body ? "POST" : "GET") => {
    const response = await fetch(new URL(path, fixture.info.url), { method, headers: {
      "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}),
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() as T };
  };
  try {
    const local = await api<{ userId?: string }>("/api/auth/session");
    expect(local.body.userId).toMatch(/^p_[\w-]{22}$/);
    for (const options of [{ label: "Phone" }, { label: "Laptop" }, { scopes: ["client"] }, { tokenTtlMs: 60_000 }]) {
      const opened = await api<{ code: string }>("/api/auth/pairing", options);
      expect(opened.status).toBe(200);
      const paired = await api<{ token: string }>("/api/auth/pair", { code: opened.body.code, userId: "claimed-owner" });
      expect(paired.body.token).toEqual(expect.any(String));
      const session = await api<{ userId?: string }>("/api/auth/session", undefined, paired.body.token);
      if (options.label) expect(session.body.userId).toBe(local.body.userId);
      else {
        expect(session.body.userId).toBeUndefined();
        expect((await api("/api/auth/pairing", {}, paired.body.token)).status).toBe(403);
      }
    }
    for (const action of ["start", "verify"]) expect((await api(`/api/auth/email/${action}`, { email: "someone@example.test" })).status).toBe(404);
    expect((await api("/api/config", { signIn: { admins: ["someone@example.test"] } }, undefined, "PATCH")).status).toBe(400);
  } finally { await fixture.close(); }
}, 60_000);
