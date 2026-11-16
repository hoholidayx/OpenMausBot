import { cloudPlanSnapshot } from "./cloud-account.mjs";

/** Another Cloud of the person's own, as its page may see its plan: its tier and whether it runs, from the session's list. */
export function otherCloudSnapshot(cloud) {
  const runs = ["ready", "setting_up", "offline"].includes(cloud.status);
  return { status: runs ? "paid" : "attention", ...(cloud.tier ? { tier: cloud.tier } : {}) };
}

export function installCloudPlanIpc({ ipcMain, pageSender, account, client, notices, homePage, otherCloud = () => null }) {
  ipcMain.handle("cloud-plan:state", event => {
    const other = otherCloud(event);
    if (other) return { ...otherCloudSnapshot(other), ...(homePage(event) ? { home: true } : {}) };
    return pageSender("cloud-plan:state", () => {
      const state = account()?.state();
      return { ...cloudPlanSnapshot(state, { notice: notices().due(state) }), ...(homePage(event) ? { home: true } : {}) };
    })(event);
  });
  ipcMain.handle("cloud-plan:notice-seen", pageSender("cloud-plan:notice-seen", () => { notices().seen(account()?.state()); }));
  ipcMain.handle("cloud-plan:manage", event => (otherCloud(event) ? client().openDashboard().then(() => {}) : pageSender("cloud-plan:manage", async () => { await client().openDashboard(); })(event)));
  // Cancel trial / Cancel plan and Keep my plan: the page's survey is checked in main, and the Cloud is the session's own.
  ipcMain.handle("cloud-plan:cancel", (event, survey) => pageSender("cloud-plan:cancel", () => client().cancelPlan(survey))(event));
  ipcMain.handle("cloud-plan:keep", pageSender("cloud-plan:keep", () => client().keepPlan()));
  // The room card (the session's `room`): Dismissal for the session's own Cloud.
}
