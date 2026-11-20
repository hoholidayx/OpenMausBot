import { useEffect, useState } from "react";
import { DesktopWorkspaceSwitcher } from "../components/DesktopWorkspaceSwitcher";
import { productName } from "../lib/brand";

import {
  defaultDeviceLabel,
  isConnected,
  newAttemptId,
  pairWithCode,
  readSessionState,
  reasonWorthShowing,
  type EnvironmentDescriptor,
  type SessionState,
} from "../lib/session";
import { pairedDestination } from "../lib/phone-pairing";
import { t } from "../lib/i18n";
import { formatPairingCode, PAIRING_INPUT_PROBLEM_KEY, readPairingInput } from "../../shared/pairing-code";
import { isPrivateHost } from "../../shared/private-host";

const input = "mt-1 w-full rounded-md border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink outline-none focus:border-accent-border";
const button = "mt-5 w-full rounded-md bg-accent px-4 py-2 text-[14px] font-medium text-accent-ink disabled:opacity-50";
const fieldLabel = "mt-4 block text-[12px] font-medium text-ink-secondary";

/** Only the desktop app pairs from a link at once; a browser asks, so a sent link cannot sign it in unseen. */
export function pairsAutomatically(initialCode: string | null, desktop = typeof window !== "undefined" && Boolean(window.ogb?.workspaces)): boolean {
  return Boolean(initialCode) && desktop;
}

/** The sentence for a wrong kind of code (an email's sign-in code, an old six-digit code, a script key), else null. */
export function codeProblem(code: string): string | null {
  const read = readPairingInput(code);
  return read.kind === "wrong" && read.problem !== "notACode" ? t(PAIRING_INPUT_PROBLEM_KEY[read.problem]) : null;
}

export function codeReady(code: string): boolean {
  const kind = readPairingInput(code).kind;
  return kind === "code" || kind === "credential";
}

/** The phone app opens this server with the code already filled in. */
export function openInAppLink(origin: string, code: string): string {
  const read = readPairingInput(code);
  const filled = read.kind === "code" ? `&code=${encodeURIComponent(formatPairingCode(read.code))}` : "";
  return `openmausbot://pair?address=${encodeURIComponent(origin)}${filled}`;
}

/** Plain http to the open internet: the session cookie and every chat would cross it readable. */
export function unencryptedPublic(where: { protocol: string; hostname: string }): boolean {
  return where.protocol === "http:" && !isPrivateHost(where.hostname);
}

export function pairTitle(environment: EnvironmentDescriptor | null): string {
  return t("pair.connectTo", { name: environment?.label ?? t("pair.thisOpenMausBot", { app: productName() }) });
}

export function PairPage({ initialCode, reason }: { initialCode: string | null; reason?: string }) {
  const [code, setCode] = useState(initialCode ?? "");
  const [label, setLabel] = useState(defaultDeviceLabel());
  const [environment, setEnvironment] = useState<EnvironmentDescriptor | null>(null);
  const [session, setSession] = useState<SessionState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attemptId, setAttemptId] = useState(() => newAttemptId());
  const [opening, setOpening] = useState(() => pairsAutomatically(initialCode));

  useEffect(() => {
    if (!opening || !initialCode) return;
    let active = true;
    void pairWithCode({ code: initialCode, label, attemptId }).then((result) => {
      if (!active) return;
      if (result.ok) { location.replace(pairedDestination(location.search)); return; }
      setOpening(false);
      setError(result.error);
    });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void fetch("/.well-known/openmausbot/environment")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: EnvironmentDescriptor | null) => {
        setEnvironment(d);
      })
      .catch(() => {
        setEnvironment(null);
      });
    void readSessionState().then(setSession);
  }, []);

  const connected = isConnected(session);
  const problem = codeProblem(code);
  const where = typeof location !== "undefined" && typeof location.protocol === "string" ? location : null;

  async function submitCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const result = await pairWithCode({ code, label, attemptId });
    setBusy(false);
    if (result.ok) {
      location.replace(pairedDestination(location.search));
      return;
    }
    setError(result.error);
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-app px-6 text-ink">
      <div className="absolute left-3 top-12 max-w-[280px]"><DesktopWorkspaceSwitcher /></div>
      <div className="w-full max-w-[420px]">
        {where && unencryptedPublic(where) ? <p role="alert" className="mb-4 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-[13px] text-warning">{t("pair.notEncrypted")}</p> : null}
        {opening ? (
          <p role="status" className="text-[20px] font-semibold">{t("pair.connectingTo", { name: environment?.label ?? t("pair.thisOpenMausBot") })}</p>
        ) : <>
        <h1 className="text-[20px] font-semibold">{pairTitle(environment)}</h1>
        <p className="mt-1.5 text-[14px] leading-relaxed text-ink-secondary">
          {environment ? `${t("pair.version", { version: environment.version, platform: environment.platform })} ` : ""}
          {t("pair.intro.code")}
        </p>
        {reasonWorthShowing(reason) && !connected ? <p className="mt-3 text-[13px] text-ink-secondary">{reasonWorthShowing(reason)}</p> : null}
        </>}
        {opening ? null : connected ? (
          <p className="mt-4 text-[14px]">
            {t("pair.alreadyConnected")}{" "}
            <a href="/" className="text-accent underline">
              {t("pair.openApp")}
            </a>
          </p>
        ) : (
          <form onSubmit={submitCode}>
            <label className={fieldLabel} htmlFor="pair-code">
              {t("pair.code")}
            </label>
            <input
              id="pair-code"
              value={code}
              onChange={(e) => {
                setCode(e.target.value);
                setAttemptId(newAttemptId());
              }}
              placeholder="XXXX-XXXX-XXXX"
              aria-describedby={initialCode && code === initialCode ? "pair-code-from-link" : undefined}
              autoComplete="one-time-code"
              autoCapitalize="characters"
              spellCheck={false}
              className={`${input} font-mono text-[15px] tracking-[0.12em]`}
            />
            {initialCode && code === initialCode ? <p id="pair-code-from-link" className="mt-1 text-[12px] text-ink-secondary">{t("pair.fromLink")}</p> : null}
            <label className={fieldLabel} htmlFor="pair-label">
              {t("pair.deviceLabel")}
            </label>
            <input id="pair-label" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} className={input} />
            {problem ? <p role="alert" className="mt-3 text-[13px] text-danger">{problem}</p> : error ? <p className="mt-3 text-[13px] text-danger">{error}</p> : null}
            <button type="submit" disabled={busy || !codeReady(code)} className={button}>
              {t(busy ? "pair.connecting" : "pair.connect")}
            </button>
            {where?.origin ? (
              <p className="mt-3 text-[13px] text-ink-secondary">
                {t("pair.onPhone")}{" "}
                <a href={openInAppLink(where.origin, code)} className="text-accent underline">{t("pair.openInApp", { app: productName() })}</a>
              </p>
            ) : null}
            <p className="mt-3 text-[13px] text-ink-secondary">
              {t("pair.noCode")} <code className="select-all rounded bg-inset px-1.5 py-0.5 text-[12px] text-ink">npx openmausbot pair</code>
            </p>
          </form>
        )}
      </div>
    </main>
  );
}
