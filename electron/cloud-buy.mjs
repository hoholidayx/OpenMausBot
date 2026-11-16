import environments from "./environments.cjs";
import { CLOUD_HOME_NAME } from "./cloud-home.mjs";
import nativeText from "./native-text.cjs";
import { dotIcons } from "./color-dot.mjs";

export const CLOUD_COLORS = environments.ENTRY_COLORS;
export const DEFAULT_CLOUD_COLOR = "blue";
export const CLOUD_NAME_MAX = 28;
/** Each colour in the default skin (src/lib/mascot.ts MAUS_COLORS), for the native menu's dot; the page uses the skin's own. */
export const CLOUD_COLOR_HEX = Object.freeze({ blue: "#377FE6", teal: "#01A492", purple: "#8057C8", orange: "#E78531", red: "#D94B52", yellow: "#D8A729" });
// oxlint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f]/;

export function cleanCloudName(value) {
  if (typeof value !== "string") return null;
  const name = value.trim().replace(/\s+/g, " ");
  return name && [...name].length <= CLOUD_NAME_MAX && !CONTROL.test(name) ? name : null;
}
export const cleanCloudColor = value => (CLOUD_COLORS.includes(value) ? value : null);

/** The native switcher's dot for a saved colour (14 pt, sharp at 2x), drawn once per colour; null where it cannot be drawn. */
export const colorDotIcons = nativeImage => dotIcons(nativeImage, CLOUD_COLOR_HEX);

/** The name and colour chosen while the Cloud is set up, kept for its account until the Cloud is listed (userData). */
export function lookFile(file, fs) {
  let cached;
  return {
    read() {
      if (cached !== undefined) return cached;
      try {
        const saved = JSON.parse(fs.readFileSync(file(), "utf8"));
        cached = typeof saved?.accountId === "string" && cleanCloudName(saved.name) && cleanCloudColor(saved.color)
          ? { accountId: saved.accountId, name: cleanCloudName(saved.name), color: saved.color } : null;
      } catch { cached = null; }
      return cached;
    },
    write(value) {
      cached = value;
      try { fs.writeFileSync(file(), JSON.stringify(value), { mode: 0o600 }); } catch {}
    },
  };
}

/** One answer to "what is this Cloud called, in which colour": its Servers entry once listed, else what was chosen, else My Cloud. */
export function createCloudLook({ store, accountId, homeEntry, saveEntry }) {
  const chosen = () => { const saved = store.read(); return saved && saved.accountId === accountId() ? { name: saved.name, color: saved.color } : null; };
  const current = () => {
    const entry = homeEntry();
    if (entry) return { name: entry.name, color: cleanCloudColor(entry.color) ?? DEFAULT_CLOUD_COLOR };
    return chosen() ?? { name: CLOUD_HOME_NAME, color: DEFAULT_CLOUD_COLOR };
  };
  return {
    /** For the Servers entry made when the Cloud is ready (cloud-home.mjs withCloudHome). */
    pending: chosen,
    current,
    save(name, color) {
      const look = { name: cleanCloudName(name), color: cleanCloudColor(color) };
      if (!look.name || !look.color) throw new Error(`Choose a name of up to ${CLOUD_NAME_MAX} characters and one of the colours.`);
      const id = accountId();
      if (id) store.write({ accountId: id, ...look });
      const entry = homeEntry();
      if (entry) saveEntry(entry.origin, look);
      return current();
    },
  };
}

/** Paid, and the Cloud still being made: a payment linked, no machine yet, or one setting up. */
const settingUp = state => state?.status === "connected" && (Boolean(state.purchase) || state.machine?.status === "provisioning"
  || (state.entitlement?.status === "active" && !state.machine));

export function createCloudReadyNotice({ Notification, name, open, t = nativeText.englishText.t }) {
  let watched = false;
  return state => {
    if (settingUp(state)) { watched = true; return false; }
    if (!watched || state?.status !== "connected" || state.machine?.status !== "ready") return false;
    watched = false;
    if (!Notification.isSupported()) return false;
    const note = new Notification({ title: t("native.cloud.ready.title", { name: name() }), body: t("native.cloud.ready.body") });
    note.on("click", () => open());
    note.show();
    return true;
  };
}
