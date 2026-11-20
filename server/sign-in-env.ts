type LegacyLists = { admins?: string[]; members?: string[] };

/** The only owner an old sign-in policy could identify, or null for a shared installation. */
export function legacyOwnerKey(lists: LegacyLists = {}, env: NodeJS.ProcessEnv = process.env): string | null {
  const entries = (value: string) => [...new Set(value.trim().toLowerCase().split(/[,\s]+/).filter(Boolean))];
  const fromEnv = entries(env.OMB_SIGNIN_EMAILS ?? "");
  const members = entries(env.OMB_SIGNIN_MEMBER_EMAILS ?? "");
  if (members.length || entries(lists.members?.join(",") ?? "").length) return null;
  const admins = fromEnv.length ? fromEnv : entries(lists.admins?.join(",") ?? "");
  if (!admins.length) return "local-owner";
  return admins.length === 1 && /^[^@\s]+@[^@\s]+$/.test(admins[0]!) ? admins[0]! : null;
}
