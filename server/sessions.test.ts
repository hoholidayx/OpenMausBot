import { pairDevice } from "./testing/paired-session.ts";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as atomic from "./atomic.ts";

import {
  EXCHANGE_REPLAY_MS,
  formatPairingCode,
  generatePairingCode,
  generatePairingCredential,
  isPairingCredential,
  LOCKOUT,
  PAIRING_LOCKOUT,
  normalizePairingCode,
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_MAX_TTL_MS,
  PAIRING_CODE_TTL_MS,
  pairingRequest,
  SESSION_TTL_MS,
  SessionRegistry,
  STREAM_TICKET_TTL_MS,
  SESSION_MAX_AGE_MS,
  cookieMaxAgeSeconds,
  daysMs,
} from "./sessions.ts";
import { userError } from "./user-errors.ts";

let dir: string;
let clock: number;
let registry: SessionRegistry;
const file = () => join(dir, "sessions.json");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omb-sessions-"));
  clock = 1_700_000_000_000;
  registry = new SessionRegistry({ file: file(), now: () => clock });
});
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

it("drops saved migration sessions while restoring ordinary pairings", () => {
  const ordinary = pairDevice(registry, { label: "Existing device", scopes: ["admin", "client"] });
  const retired = pairDevice(registry, { label: "Transfer session", scopes: ["admin", "client"] });
  registry.close();
  const stored = JSON.parse(readFileSync(file(), "utf8"));
  stored.sessions.find((row: { id: string }) => row.id === retired.session.id).moveIn = "old-bot";
  writeFileSync(file(), JSON.stringify(stored));

  registry = new SessionRegistry({ file: file(), now: () => clock });
  expect(registry.authenticate(ordinary.token)?.id).toBe(ordinary.session.id);
  expect(registry.authenticate(retired.token)).toBeNull();
  registry.close();
});

describe("the native-app encoding of a pairing window", () => {
  it("redeems the same window as the typed code, and consumes it", () => {
    const { code, credential } = registry.openPairing({ label: "Pixel" });
    // The Android companion's parser demands the 9-character prefix plus exactly 43 base64url characters (Connection.kt).
    expect(credential.startsWith("omb_pair_")).toBe(true);
    expect(credential.length).toBe(52);
    expect(credential.slice("omb_pair_".length)).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const paired = registry.exchange({ code: credential, label: "Pixel", source: "10.0.0.9" });
    expect(paired.ok).toBe(true);
    expect(registry.exchange({ code, label: "again", source: "10.0.0.9" }).ok).toBe(false);
    expect(registry.openPairings()).toEqual([]);
  });

  it("never normalizes a credential", () => {
    // A credential containing every symbol normalizePairingCode folds (0, 1, _ and -): it must be hashed exactly as presented.
    const trap = "omb_pair_0123456789-_abcdefghijklmnopqrstuvwxyzABCDE";
    expect(trap.length).toBe(52);
    expect(normalizePairingCode(trap)).not.toBe(trap);
    expect(isPairingCredential(trap)).toBe(true);

    const { credential } = registry.openPairing();
    expect(registry.exchange({ code: trap, label: "", source: "attacker" }).ok).toBe(false);
    expect(registry.exchange({ code: credential, label: "", source: "friend" }).ok).toBe(true);
  });

  it("keeps two live windows apart", () => {
    const first = registry.openPairing({ label: "one" });
    const second = registry.openPairing({ label: "two" });
    const paired = registry.exchange({ code: second.credential, label: "", source: "10.0.0.4" });
    if (!paired.ok) throw new Error(paired.error);
    expect(paired.session.label).toBe("two");
    expect(registry.exchange({ code: first.code, label: "", source: "10.0.0.4" }).ok).toBe(true);
  });

  it("expires with its window and is counted by the same lockout", () => {
    const { credential } = registry.openPairing();
    clock += PAIRING_CODE_TTL_MS + 1;
    expect(registry.exchange({ code: credential, label: "", source: "b" }).ok).toBe(false);

    for (let attempt = 0; attempt < PAIRING_LOCKOUT.failures; attempt += 1) {
      registry.exchange({ code: generatePairingCredential(), label: "", source: "attacker" });
    }
    const locked = registry.exchange({ code: registry.openPairing().credential, label: "", source: "attacker" });
    expect(locked.ok).toBe(false);
    if (locked.ok) throw new Error("expected a lockout");
    expect(locked.status).toBe(429);
  });

  it("mints a fresh credential for every window", () => {
    const seen = new Set([...Array(20)].map(() => registry.openPairing().credential));
    expect(seen.size).toBe(20);
  });
});

function pair(label = "MacBook", source = "10.0.0.2") {
  const { code } = registry.openPairing();
  const result = registry.exchange({ code, label, source });
  if (!result.ok) throw new Error(result.error);
  return result;
}

describe("pairing codes", () => {
  it("are 12 unambiguous symbols and survive human retyping", () => {
    for (let i = 0; i < 50; i++) {
      const code = generatePairingCode();
      expect(code).toHaveLength(12);
      for (const ch of code) expect(PAIRING_CODE_ALPHABET).toContain(ch);
    }
    expect(formatPairingCode("ABCDEFGHJKLM")).toBe("ABCD-EFGH-JKLM");
    expect(normalizePairingCode(" abcd-efgh jklm ")).toBe("ABCDEFGHJKLM");
    expect(normalizePairingCode("0O1I")).toBe("OOII");
  });

  it("exchange once, then never again, and expire after five minutes", () => {
    const { code } = registry.openPairing({ label: "phone" });
    const first = registry.exchange({ code: formatPairingCode(code).toLowerCase(), label: "", source: "a" });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.session.label).toBe("phone");
    const again = registry.exchange({ code, label: "x", source: "a" });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toMatch(/wrong or has expired/);
    expect(again).toMatchObject({ status: 401, code: "pairing_code_wrong", errorKey: "serverError.pair.codeWrong" });
    const { code: stale } = registry.openPairing();
    clock += PAIRING_CODE_TTL_MS + 1;
    expect(registry.exchange({ code: stale, label: "x", source: "b" }).ok).toBe(false);
    expect(registry.openPairings()).toEqual([]);
  });

  it("stay open as long as asked, up to a day, and still work once", () => {
    const { code, expiresAt } = registry.openPairing({ label: "server", ttlMs: PAIRING_CODE_MAX_TTL_MS });
    expect(expiresAt).toBe(clock + 24 * 3_600_000);
    clock += 23 * 3_600_000;
    expect(registry.exchange({ code, label: "", source: "a" }).ok).toBe(true);
    expect(registry.exchange({ code, label: "", source: "a" }).ok).toBe(false);
    const { code: late } = registry.openPairing({ ttlMs: PAIRING_CODE_MAX_TTL_MS });
    clock += PAIRING_CODE_MAX_TTL_MS + 1;
    expect(registry.exchange({ code: late, label: "", source: "b" }).ok).toBe(false);
  });

  it("takes a code's term and a token's from the request, and refuses either out of bounds", () => {
    expect(pairingRequest({ label: "CI", scopes: ["client", "root"], ttlMs: 86_400_000 })).toEqual({ label: "CI", scopes: ["client"], ttlMs: 86_400_000 });
    expect(pairingRequest({ tokenTtlMs: SESSION_MAX_AGE_MS })).toEqual({ tokenTtlMs: SESSION_MAX_AGE_MS });
    expect(pairingRequest(null)).toEqual({});
    for (const ttlMs of [86_400_001, 59_999, 1.5e6 + 0.5, "24h"]) expect(pairingRequest({ ttlMs }), String(ttlMs)).toMatchObject({ error: expect.stringContaining("24 hours") });
    expect(pairingRequest({ tokenTtlMs: SESSION_MAX_AGE_MS + 1 })).toMatchObject({ error: expect.stringContaining("OMB_SESSION_MAX_DAYS") });
  });

  it("locks a source out after repeated failures, and forgets on success", () => {
    for (let i = 0; i < PAIRING_LOCKOUT.failures; i++) {
      expect(registry.exchange({ code: "AAAAAAAAAAAA", label: "", source: "attacker" }).ok).toBe(false);
    }
    const { code } = registry.openPairing();
    const locked = registry.exchange({ code, label: "", source: "attacker" });
    expect(locked.ok).toBe(false);
    if (!locked.ok) {
      expect(locked.status).toBe(429);
      expect(locked.error).toMatch(/^Too many wrong codes\. Try again at \d{2}:\d{2} UTC\.$/);
      expect(locked).toMatchObject({ code: "pairing_too_many", errorKey: "serverError.pair.tooMany", errorParams: { seconds: 300, until: clock + 300_000 } });
    }
    expect(registry.exchange({ code, label: "", source: "friend" }).ok).toBe(true);
    clock += PAIRING_LOCKOUT.lockMs + 1;
    const { code: fresh } = registry.openPairing();
    expect(registry.exchange({ code: fresh, label: "", source: "attacker" }).ok).toBe(true);
  });

  it("five wrong codes in five minutes lock that address for five minutes; a code lives ten minutes", () => {
    expect(PAIRING_LOCKOUT).toEqual({ failures: 5, windowMs: 300_000, lockMs: 300_000 });
    expect(PAIRING_CODE_TTL_MS).toBe(600_000);
    for (let i = 0; i < 4; i++) registry.exchange({ code: "AAAAAAAAAAAA", label: "", source: "slow" });
    clock += 299_000;
    const fifth = registry.exchange({ code: "AAAAAAAAAAAA", label: "", source: "slow" });
    expect(fifth.ok === false && fifth.status).toBe(401);
    const { code } = registry.openPairing();
    const locked = registry.exchange({ code, label: "", source: "slow" });
    expect(locked.ok === false && locked.status).toBe(429);
  });

  it("never locks out the address a proxy that names no client gives everyone; wrong codes from it burn the open codes", () => {
    const owners = registry.openPairing();
    for (let i = 0; i < PAIRING_LOCKOUT.failures; i++) {
      expect(registry.exchange({ code: "AAAAAAAAAAAA", label: "", source: "127.0.0.1" })).toMatchObject({ ok: false, status: 401 });
    }
    expect(registry.exchange({ code: owners.code, label: "", source: "127.0.0.1" })).toMatchObject({ ok: false, status: 401 });
    const fresh = registry.openPairing();
    expect(registry.exchange({ code: fresh.code, label: "", source: "127.0.0.1" }).ok).toBe(true);
    for (const source of ["::1", "::ffff:127.0.0.1", "unknown"]) {
      for (let i = 0; i < PAIRING_LOCKOUT.failures + 1; i++) registry.exchange({ code: "AAAAAAAAAAAA", label: "", source });
      expect(registry.exchange({ code: registry.openPairing().code, label: "", source }).ok, source).toBe(true);
    }
  });

  it("bad signatures have a separate limit from pairing attempts", () => {
    for (let i = 0; i < PAIRING_LOCKOUT.failures; i++) registry.noteFailure("mail");
    expect(registry.attemptAllowed("mail")).toEqual({ ok: true });
    for (let i = PAIRING_LOCKOUT.failures; i < LOCKOUT.failures; i++) registry.noteFailure("mail");
    expect(registry.attemptAllowed("mail").ok).toBe(false);
    expect(registry.exchange({ code: registry.openPairing().code, label: "", source: "mail" }).ok).toBe(true);
  });

  it("explains a code of the wrong kind and does not count it as a guess", () => {
    for (const [input, key, code] of [["1234 5678", "serverError.pair.emailCode", "pairing_email_code"], ["123456", "serverError.pair.oldCode", "pairing_old_code"], [`omb_sess_${"a".repeat(43)}`, "serverError.pair.scriptKey", "pairing_script_key"]] as const) {
      for (let i = 0; i < PAIRING_LOCKOUT.failures + 1; i++) {
        const refused = registry.exchange({ code: input, label: "", source: "mixed-up" });
        expect(refused).toMatchObject({ ok: false, status: 400, code, errorKey: key });
      }
    }
    expect(registry.failureSources()).not.toContain("mixed-up");
  });

  it("takes the code or the credential out of a pasted link", () => {
    const a = registry.openPairing();
    expect(registry.exchange({ code: `https://maus.example.com/pair#code=${formatPairingCode(a.code)}`, label: "", source: "s" }).ok).toBe(true);
    const b = registry.openPairing();
    expect(registry.exchange({ code: `openmausbot://pair?address=https%3A%2F%2Fmaus.example.com&token=${b.credential}`, label: "", source: "s" }).ok).toBe(true);
  });

  it("answers a lost-response retry with the same session for a minute, keyed on the client's attempt id", () => {
    const { code } = registry.openPairing();
    const first = registry.exchange({ code, label: "phone", source: "a", attemptId: "attempt-0001-abcd" });
    expect(first.ok).toBe(true);
    expect(registry.exchange({ code, label: "phone", source: "b", attemptId: "attempt-0001-abcd" })).toEqual(first);
    expect(registry.list()).toHaveLength(1);
    expect(registry.exchange({ code, label: "x", source: "a", attemptId: "attempt-0002-efgh" }).ok).toBe(false);
    expect(registry.exchange({ code, label: "x", source: "a" }).ok).toBe(false);
    const { code: c2 } = registry.openPairing();
    expect(registry.exchange({ code: c2, label: "p", source: "a", attemptId: "no" }).ok).toBe(true);
    expect(registry.exchange({ code: c2, label: "p", source: "a", attemptId: "no" }).ok).toBe(false);
    clock += EXCHANGE_REPLAY_MS + 1;
    expect(registry.exchange({ code, label: "phone", source: "a", attemptId: "attempt-0001-abcd" }).ok).toBe(false);
  });

  it("forgets a source's failures once its window and lock have passed", () => {
    registry.exchange({ code: "AAAAAAAAAAAA", label: "", source: "flaky" });
    expect(registry.failureSources()).toContain("flaky");
    clock += PAIRING_LOCKOUT.windowMs + 1;
    registry.openPairing();
    expect(registry.failureSources()).not.toContain("flaky");
  });

  it("names the device from the client, else the code's label, else the user agent", () => {
    const a = registry.openPairing({ label: "Milind's MacBook" });
    const named = registry.exchange({ code: a.code, label: "", source: "s1", fallbackLabel: "Safari on Mac" });
    if (!named.ok) throw new Error(named.error);
    expect(named.session.label).toBe("Milind's MacBook");
    const b = registry.openPairing();
    const ua = registry.exchange({ code: b.code, label: "  ", source: "s2", fallbackLabel: "Safari on Mac" });
    if (!ua.ok) throw new Error(ua.error);
    expect(ua.session.label).toBe("Safari on Mac");
    const c = registry.openPairing({ label: "ignored" });
    const explicit = registry.exchange({ code: c.code, label: "Kitchen iPad", source: "s3", fallbackLabel: "Safari on iPad" });
    if (!explicit.ok) throw new Error(explicit.error);
    expect(explicit.session.label).toBe("Kitchen iPad");
  });

  it("drops control and bidirectional-formatting characters from a device's name", () => {
    const { code } = registry.openPairing();
    const named = registry.exchange({ code, label: "Safari\u202E on iPad\n\u0007\u2066", source: "s4" });
    if (!named.ok) throw new Error(named.error);
    expect(named.session.label).toBe("Safari on iPad");
    const blank = registry.exchange({ code: registry.openPairing().code, label: "\u202E\u0000", source: "s5", fallbackLabel: "Chrome\u200F on Mac" });
    if (!blank.ok) throw new Error(blank.error);
    expect(blank.session.label).toBe("Chrome on Mac");
    expect(pairDevice(registry, { label: "Ada\u202Es phone\r", scopes: ["client"] }).session.label).toBe("Adas phone");
  });

  it("carries scopes from the code into the session, deduplicated", () => {
    const { code } = registry.openPairing({ scopes: ["client", "client"] });
    const result = registry.exchange({ code, label: "viewer", source: "s" });
    if (!result.ok) throw new Error(result.error);
    expect(result.session.scopes).toEqual(["client"]);
    expect(pair().session.scopes).toEqual(["admin", "client"]);
  });
});

describe("sessions", () => {
  it("refuses to load persisted sessions when the marker cannot be established on the real filesystem", () => {
    const blocked = join(dir, "blocked.json");
    const paired = pair();
    writeFileSync(blocked, readFileSync(file(), "utf8"));
    mkdirSync(`${blocked}.open`); // An atomic file replace cannot overwrite a directory, even as root.
    expect(() => new SessionRegistry({ file: blocked, now: () => clock })).toThrow("Could not establish safe session storage.");
    expect(readFileSync(blocked, "utf8")).toContain(paired.session.id);
  });

  it("still reduces the in-memory set when persisting a prune fails", () => {
    pair();
    clock += SESSION_TTL_MS + 1;
    const logger = vi.spyOn(console, "error").mockImplementation(() => {});
    const writes = vi.spyOn(atomic, "writeFileAtomic").mockImplementation(() => { throw new Error("EIO: the session file is unwritable"); });
    expect(() => registry.list(), "the heartbeat prunes through isLive(), where a throw would exit the process").not.toThrow();
    expect(registry.list()).toEqual([]);
    expect(logger.mock.calls.flat().join(" ")).toContain("Could not persist session pruning.");
    writes.mockRestore();
  });

  it("stores only a hash, owner-only, and reloads from disk", () => {
    const { token, session } = pair();
    const onDisk = readFileSync(file(), "utf8");
    expect(onDisk).not.toContain(token);
    expect(onDisk).toContain(session.id);
    if (process.platform !== "win32") expect(statSync(file()).mode & 0o777).toBe(0o600); // Windows has no POSIX modes
    const reloaded = new SessionRegistry({ file: file(), now: () => clock });
    expect(reloaded.authenticate(token)?.id).toBe(session.id);
    expect(reloaded.authenticate("omb_sess_nope")).toBeNull();
  });

  it("expires after 30 days and can be revoked", () => {
    const { token, session } = pair();
    clock += SESSION_TTL_MS - 1;
    expect(registry.authenticate(token)?.id).toBe(session.id);
    clock += 2;
    expect(registry.authenticate(token)).toBeNull();
    const other = pair("iPad");
    expect(registry.list().map((s) => s.label)).toEqual(["iPad"]);
    expect(registry.revoke(other.session.id)).toBe(true);
    expect(registry.revoke(other.session.id)).toBe(false);
    expect(registry.authenticate(other.token)).toBeNull();
  });

  it("updates last-seen at most once a minute so reads stay cheap", () => {
    const { token } = pair();
    const before = statSync(file()).mtimeMs;
    clock += 1_000;
    registry.authenticate(token);
    expect(registry.list()[0]?.lastSeenAt).toBe(clock - 1_000);
    clock += 60_000;
    registry.authenticate(token);
    expect(registry.list()[0]?.lastSeenAt).toBe(clock);
    expect(statSync(file()).mtimeMs).toBeGreaterThanOrEqual(before);
  });

  it("opens an access token that lasts exactly its term, never renews, and stays one after a restart", () => {
    const term = 90 * 24 * 3_600_000;
    const { code } = registry.openPairing({ label: "Nightly CI", scopes: ["client"], tokenTtlMs: term });
    const paired = registry.exchange({ code, label: "", source: "ci" });
    if (!paired.ok) throw new Error(paired.error);
    expect(paired.session).toMatchObject({ label: "Nightly CI", scopes: ["client"], token: true, expiresAt: clock + term });
    clock += term - 60_000;
    expect(registry.authenticate(paired.token)?.id).toBe(paired.session.id);
    expect(registry.renew(paired.session.id)).toBe(false);
    expect(new SessionRegistry({ file: file(), now: () => clock }).list()).toMatchObject([{ id: paired.session.id, token: true, expiresAt: paired.session.expiresAt }]);
    clock += 60_001;
    expect(registry.authenticate(paired.token)).toBeNull();
  });

  it("caps a token at the longest session", () => {
    const { code } = registry.openPairing({ tokenTtlMs: SESSION_MAX_AGE_MS * 2 });
    const long = registry.exchange({ code, label: "", source: "c" });
    expect(long.ok && long.session.expiresAt).toBe(clock + SESSION_MAX_AGE_MS);
  });

  it("renews a session with half its term or less left, and never revives an expired one", () => {
    const { token, session } = pair();
    clock += SESSION_TTL_MS / 2 - 60_000;
    expect(registry.renew(session.id)).toBe(false);
    expect(registry.list()[0]?.expiresAt).toBe(session.expiresAt);
    clock += 120_000;
    expect(registry.renew(session.id)).toBe(true);
    expect(registry.list()[0]?.expiresAt).toBe(clock + SESSION_TTL_MS);
    expect(registry.renew(session.id)).toBe(false);
    clock += SESSION_TTL_MS - 1;
    expect(registry.authenticate(token)?.id).toBe(session.id);
    expect(registry.renew(session.id)).toBe(true);
    const reloaded = new SessionRegistry({ file: file(), now: () => clock });
    expect(reloaded.list()[0]?.expiresAt).toBe(clock + SESSION_TTL_MS);
    const quiet = pair("iPad");
    clock += SESSION_TTL_MS + 1;
    expect(registry.renew(quiet.session.id)).toBe(false);
    expect(registry.authenticate(quiet.token)).toBeNull();
  });

  it("stops renewing at the absolute cap counted from pairing", () => {
    const { token, session } = pair();
    const cap = session.createdAt + SESSION_MAX_AGE_MS;
    let last = session.expiresAt;
    for (let i = 0; i < 20; i += 1) {
      clock = last - SESSION_TTL_MS / 2;
      registry.renew(session.id);
      const now = registry.list()[0]?.expiresAt ?? 0;
      expect(now).toBeLessThanOrEqual(cap);
      expect(now).toBeGreaterThanOrEqual(last);
      last = now;
    }
    expect(last).toBe(cap);
    clock = cap - 1;
    expect(registry.authenticate(token)?.id).toBe(session.id);
    expect(registry.renew(session.id)).toBe(false);
    clock = cap + 1;
    expect(registry.authenticate(token)).toBeNull();
  });

  it("applies the cap to a session paired long before this version", () => {
    const day = 24 * 60 * 60_000;
    const old = {
      id: "old-device", userId: registry.userId, tokenHash: "0".repeat(64), label: "old laptop", scopes: ["admin"],
      createdAt: clock - 160 * day, lastSeenAt: clock - day, expiresAt: clock + 15 * day,
    };
    const older = { ...old, id: "older-device", tokenHash: "1".repeat(64), createdAt: clock - 175 * day };
    writeFileSync(file(), JSON.stringify({ version: 2, ownerId: registry.userId, sessions: [old, older] }));
    const loaded = new SessionRegistry({ file: file(), now: () => clock });
    expect(loaded.renew("old-device")).toBe(true);
    expect(loaded.list()[0]?.expiresAt).toBe(old.createdAt + SESSION_MAX_AGE_MS);
    expect(loaded.renew("older-device")).toBe(false);
    expect(loaded.list()[1]?.expiresAt).toBe(older.expiresAt);
  });

  it("reads whole days from the environment and falls back on anything else", () => {
    const day = 24 * 60 * 60_000;
    expect(daysMs(undefined, 30)).toBe(30 * day);
    expect(daysMs("7", 30)).toBe(7 * day);
    for (const bad of ["0", "-1", "0.5", "soon", "1e308", "3651", ""]) expect(daysMs(bad, 30)).toBe(30 * day);
    expect(daysMs("3650", 30)).toBe(3650 * day);
  });

  it("gives a cookie whole seconds, never less than one", () => {
    expect(cookieMaxAgeSeconds({ expiresAt: 10_500 }, 0)).toBe(10);
    expect(cookieMaxAgeSeconds({ expiresAt: 100 }, 0)).toBe(1);
    expect(cookieMaxAgeSeconds({ expiresAt: 0 }, 5_000)).toBe(1);
  });
});

describe("stream tickets", () => {
  it("are single use, short-lived, and die with their session", () => {
    const { session } = pair();
    const { ticket } = registry.issueStreamTicket(session.id);
    expect(registry.redeemStreamTicket(ticket)?.id).toBe(session.id);
    expect(registry.redeemStreamTicket(ticket)).toBeNull();
    const { ticket: late } = registry.issueStreamTicket(session.id);
    clock += STREAM_TICKET_TTL_MS + 1;
    expect(registry.redeemStreamTicket(late)).toBeNull();
    const { ticket: orphan } = registry.issueStreamTicket(session.id);
    registry.revoke(session.id);
    expect(registry.redeemStreamTicket(orphan)).toBeNull();
  });
});

describe("admin scope only (an OMB Cloud home is personal: server/cloud-owner.ts)", () => {
  const PERSONAL = "My Cloud is personal: only your own devices can connect.";
  it("opens, redeems, issues and accepts nothing without admin scope; the owner's devices are unaffected", () => {
    // Made before the rule applies (as a stored session is at boot).
    const earlier = registry.openPairing({ scopes: ["client"], label: "Guest phone" });
    const stored = registry.exchange({ code: earlier.credential, label: "Guest phone", source: "a" });
    expect(stored.ok).toBe(true);
    const ticket = stored.ok ? registry.issueStreamTicket(stored.session.id).ticket : "";
    const openWindow = registry.openPairing({ scopes: ["client"] });
    const owner = registry.exchange({ code: registry.openPairing().credential, label: "Mac", source: "a" });
    registry.requireAdmin(userError("serverError.cloud.personal"));
    expect(() => registry.openPairing({ scopes: ["client"] })).toThrow(PERSONAL);
    expect(registry.exchange({ code: openWindow.credential, label: "Guest", source: "b" })).toEqual({ ok: false, status: 403, code: "cloud_personal", error: PERSONAL, errorKey: "serverError.cloud.personal" });
    if (!stored.ok || !owner.ok) throw new Error("unreachable");
    expect(registry.authenticate(stored.token)).toBeNull();
    expect(registry.redeemStreamTicket(ticket)).toBeNull();
    expect(registry.isLive(stored.session.id)).toBe(false);
    expect(registry.authenticate(owner.token)?.id).toBe(owner.session.id);
    expect(registry.isLive(owner.session.id)).toBe(true);
    const next = registry.exchange({ code: registry.openPairing({ scopes: ["admin"] }).credential, label: "Phone", source: "c" });
    expect(next.ok).toBe(true);
  });
});

describe("telling the server a session opened", () => {
  it("names every session opened by pairing or sign-in, with its scopes", () => {
    const opened: string[][] = [];
    registry.onSessionIssued((session) => opened.push(session.scopes));
    const { code } = registry.openPairing({ label: "Phone", scopes: ["client"] });
    expect(registry.exchange({ code, label: "Phone", source: "10.0.0.9" }).ok).toBe(true);
    pairDevice(registry, { label: "Laptop", scopes: ["admin", "client"] });
    expect(opened).toEqual([["client"], ["admin", "client"]]);
  });
});

describe("the installation's owner", () => {
  const device = (label: string, scopes: Array<"admin" | "client"> = ["admin", "client"]) => pairDevice(registry, { label, scopes });
  const reopen = () => new SessionRegistry({ file: file(), now: () => clock });

  it("counts only live chat-only pairings and sessions", () => {
    device("Laptop");
    expect(registry.hasChatOnlyAccess()).toBe(false);
    const window = registry.openPairing({ scopes: ["client"], ttlMs: 60_000 });
    expect(registry.hasChatOnlyAccess()).toBe(true);
    clock = window.expiresAt + 1;
    expect(registry.hasChatOnlyAccess()).toBe(false);
    const limited = device("Chat", ["client"]);
    expect(registry.hasChatOnlyAccess()).toBe(true);
    registry.revoke(limited.session.id);
    expect(registry.hasChatOnlyAccess()).toBe(false);
  });

  it("keeps each device's scopes and revocation across restarts", () => {
    const laptop = device("Laptop"), phone = device("Phone"), limited = device("Chat", ["client"]);
    const ownerId = registry.userId;
    registry.close();
    registry = reopen();
    expect(registry.userId).toBe(ownerId);
    for (const { token } of [laptop, phone]) expect(registry.authenticate(token)?.userId).toBe(ownerId);
    expect(registry.authenticate(limited.token)).toMatchObject({ id: limited.session.id, scopes: ["client"] });
    expect(registry.authenticate(limited.token)?.userId).toBeUndefined();
    expect(registry.revoke(laptop.session.id)).toBe(true);
    registry.close();
    registry = reopen();
    expect(registry.authenticate(laptop.token)).toBeNull();
    expect(registry.authenticate(phone.token)?.userId).toBe(ownerId);
  });

  it("discards older session files and accepts a fresh pairing", () => {
    const previous = device("Laptop");
    registry.close();
    const { sessions } = JSON.parse(readFileSync(file(), "utf8"));
    writeFileSync(file(), JSON.stringify({ version: 1, sessions }));
    registry = reopen();
    expect(registry.authenticate(previous.token)).toBeNull();
    const fresh = device("New pairing");
    registry.close();
    registry = reopen();
    expect(registry.authenticate(fresh.token)?.userId).toBe(registry.userId);
    expect(registry.authenticate(previous.token)).toBeNull();
  });

  it("requires fresh credentials when a session file belongs to a different installation", () => {
    const laptop = device("Laptop"), limited = device("Chat", ["client"]);
    const other = join(dir, "other", "sessions.json");
    mkdirSync(join(dir, "other"));
    writeFileSync(other, readFileSync(file()));
    const restored = new SessionRegistry({ file: other, now: () => clock });
    expect(restored.userId).not.toBe(registry.userId);
    for (const { token } of [laptop, limited]) expect(restored.authenticate(token)).toBeNull();
    restored.close();
  });
});
