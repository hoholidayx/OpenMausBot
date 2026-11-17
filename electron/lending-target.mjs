/** The saved Clouds that belong to the signed-in account. */
export function createLendingTarget({ account, environments, clean = null }) {
  let lastHome = null;
  const signedIn = () => (clean?.stranded() ? null : account());
  const mine = () => {
    const current = signedIn();
    if (!current) return null;
    const state = current.state();
    const accountId = state.account?.id ?? null;
    const origin = state.status === "connected" ? (state.machine?.origin ?? null) : null;
    if (origin && accountId) lastHome = { accountId, origin };
    else if (!accountId || lastHome?.accountId !== accountId) lastHome = null;
    return { status: state.status === "signed-out" && state.message === "restoring" ? "restoring" : state.status, accountId, origin };
  };
  const cloud = (env = null) => {
    const base = mine();
    if (!base || !env?.cloud || base.origin === env.origin) return base;
    return signedIn()?.isOwnCloud?.(env.origin) ? { ...base, origin: env.origin } : base;
  };
  const environment = () => {
    const snapshot = mine();
    const origin = snapshot?.origin ?? (lastHome?.accountId === snapshot?.accountId ? lastHome?.origin : null);
    return origin ? environments().find((entry) => entry.origin === origin) ?? null : null;
  };
  return {
    cloud,
    environment,
    places() {
      const home = environment();
      const others = environments().filter((entry) => entry.cloud && entry !== home && signedIn()?.isOwnCloud?.(entry.origin));
      return [...(home ? [home] : []), ...others];
    },
  };
}
