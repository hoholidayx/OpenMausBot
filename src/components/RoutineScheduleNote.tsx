import { t } from "@/lib/i18n";
import { localDesktopPage } from "./onboarding/WelcomeGate";

export function RoutineScheduleNote() {
  const local = localDesktopPage() && window.ogb?.remoteClient?.active !== true;
  const place = local ? "local" : "server";
  return <p data-routine-schedule-note={place} className="text-[11px] leading-relaxed text-ink-secondary">
    {t(local ? "routines.scheduleNote.local" : "routines.scheduleNote.server")}
  </p>;
}
