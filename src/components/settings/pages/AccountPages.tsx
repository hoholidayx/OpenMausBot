import { useState } from "react";
import { t } from "@/lib/i18n";
import { api } from "@/state/store";
import { PlaceBadge } from "../SettingsNav";
import { SignOutConfirm } from "../SignOutConfirm";
import { SettingRow, SettingsGroup, SettingsLinkRow, SettingsRows } from "../../SettingsPrimitives";
import { useYou } from "../account-summary";
import { useSettingsShell } from "../settings-shell";
import { profileLabel } from "../../SidebarProfileMenu";

export function AccountPage() {
  const { place, go } = useSettingsShell();
  const { profile, session } = useYou();
  const [signingOut, setSigningOut] = useState(false);
  return <>
    <SettingsGroup block="you">
      <SettingsRows>
        <SettingsLinkRow title={t("settings.account.nameRow")} badge={<PlaceBadge place={place} size={14} />} value={profileLabel(profile)}
          onClick={() => go("bots", "about-you")} data={{ "data-account-name-row": "" }} />
      </SettingsRows>
    </SettingsGroup>
    {session?.kind === "session" && <SettingsGroup block="mausbot-account">
      <SettingsRows>
        <SettingRow title={t("settings.account.signedInTo", { place: place.name })} subtitle={profile?.email}>{null}</SettingRow>
        <SettingRow title={t("settings.account.signOutBrowser")}>
          <button type="button" data-danger="" className="settings-quiet cursor-pointer" onClick={() => setSigningOut(true)}>{t("settings.account.signOutShort")}</button>
        </SettingRow>
      </SettingsRows>
      {signingOut && <SignOutConfirm browser here={place.name} onConfirm={() => api("/api/auth/logout", { method: "POST" }).finally(() => location.reload())} onClose={() => setSigningOut(false)} />}
    </SettingsGroup>}
  </>;
}
