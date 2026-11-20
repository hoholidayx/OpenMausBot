import type { Scope, SessionRegistry } from "../sessions.ts";

export function pairDevice(registry: SessionRegistry, input: { label: string; scopes: Scope[] }) {
  const { credential } = registry.openPairing(input);
  const result = registry.exchange({ code: credential, source: "127.0.0.1", label: input.label });
  if (!result.ok) throw new Error(result.error);
  return result;
}
