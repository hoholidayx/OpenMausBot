// The whole app as a new Cloud's owner sees it (scripts/verify-cloud-welcome.ts answers the session as one).
// ?desktop=1 adds the reduced bridge a Cloud's page gets in the desktop app; ?move=copy|done shows the one-time move on its
// way or landed; ?step= opens the welcome on a step; ?skin= picks a skin.
import { createRoot } from "react-dom/client";
import App from "../../src/App";
import { returnToWelcome } from "../../src/lib/cloud-welcome";
import { initialDesktopCapabilities } from "../../src/lib/desktop";
import { applySkin, type SkinId } from "../../src/lib/skins";
import "../../src/styles.css";

const params = new URLSearchParams(location.search);

function installCloudPage() {
  const name = params.get("name") ?? "My Cloud";
  window.ogb = {
    platform: "darwin",
    getCapabilities: async () => initialDesktopCapabilities(),
    onCapabilitiesChanged: () => () => {},
    workspaces: { state: async () => ({ local: false, name, origin: location.origin, home: true }), menu: async () => {} },
    cloudPlan: {
      state: async () => ({ status: "paid", tier: "pro", credit: { grantedUsd: 5, remainingUsd: 5, state: "active" } }),
      manage: async () => {},
    },
  } as unknown as typeof window.ogb;
}

if (params.get("desktop") === "1") installCloudPage();
applySkin((params.get("skin") ?? "midnight") as SkinId);
const step = params.get("step");
if (step) returnToWelcome(step);
createRoot(document.getElementById("root")!).render(<App />);
