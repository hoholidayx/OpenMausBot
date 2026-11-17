import { useMemo, type RefObject } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useStore, type Bot } from "@/state/store";
import { t } from "@/lib/i18n";
import { toolStepLabel } from "@/lib/tool-step-label";
import type { LocaleKey } from "@/locales";
import type { BotToolBlock, BotToolNotice, BotToolSource } from "../../../shared/bot-tool-catalog";
import type { ToolGroup } from "../../../shared/tool-groups";
import { allowsTool, canUseMcpServer, parseToolScope } from "../../../shared/tool-scope";
import { assertToolScopeSupported } from "../../../shared/tool-scope-support";
import { CardLabel, ItemRow, NoteRow } from "../bot-panel/rows";
import { Switch } from "../SettingsPrimitives";
import { shownToolGroups, toolGroupLabel } from "./ToolGroupsCard";
import type { useBotToolCatalog } from "./useBotToolCatalog";
import type { BotPatch } from "./useBotSettingsDerived";

export type ToolFilter = "all" | "mounted" | "unmounted";
type Reason = BotToolBlock | "group-off" | "rules" | "invalid-rules" | "unsupported-rules";
const REASONS: Record<Reason, LocaleKey> = {
  engine: "botTools.reason.engine",
  environment: "botTools.reason.environment",
  disabled: "botTools.reason.disabled",
  "not-mounted": "botTools.reason.notMounted",
  "not-connected": "botTools.reason.notConnected",
  unauthorized: "botTools.reason.unauthorized",
  policy: "botTools.reason.policy",
  "group-off": "botTools.reason.groupOff",
  rules: "botTools.reason.rules",
  "invalid-rules": "botTools.reason.invalidRules",
  "unsupported-rules": "botTools.reason.unsupportedRules",
};
const NOTICES: Record<BotToolNotice, LocaleKey> = {
  "engine-catalog": "botTools.notice.engine",
  "turn-dependent": "botTools.notice.turn",
  "person-dependent": "botTools.notice.person",
  "sign-in": "botTools.notice.signIn",
  "connection-failed": "botTools.notice.connectionFailed",
  unlisted: "botTools.notice.unlisted",
  partial: "botTools.notice.partial",
};

function sourceLabel(source: BotToolSource): string {
  if (source.group) return toolGroupLabel(source.group);
  switch (source.kind) {
    case "native": return t("botTools.source.native");
    case "agents": return t("botTools.source.builtIn");
    case "browser": return t("botAccess.browser.title");
    case "computer": return t("botPanel.tab.computer");
    case "phone": return t("botAccess.phone.title");
    case "mcp": return t("botTools.source.mcp", { name: source.name ?? source.id });
    default: return t("botTools.source.app", { name: source.name ?? source.id });
  }
}

type ToolRow = { id: string; label: string; identity: string; status: Exclude<ToolFilter, "all"> | "unknown"; reason?: Reason };
type SourceHeader = { id: string; label: string; source: BotToolSource; reason?: Reason; notice?: BotToolNotice; empty: boolean; loading?: boolean };
type ListRow = ToolRow | SourceHeader;
type Catalog = ReturnType<typeof useBotToolCatalog>;

function toolRulesProblem(bot: Bot, engineKind?: string): Reason | undefined {
  if (!parseToolScope(bot.toolScope).ok) return "invalid-rules";
  if (!engineKind) return;
  try {
    assertToolScopeSupported(engineKind, bot.toolScope);
  } catch {
    return "unsupported-rules";
  }
}

function filteredTools(tools: BotToolSource["tools"], source: BotToolSource, bot: Bot, query: string,
  filter: ToolFilter, blocked?: Reason): ToolRow[] {
  return tools.flatMap(({ tool, blocked: toolBlock }): ToolRow[] => {
    const identity = tool.kind === "mcp" ? `mcp:${tool.server}:${tool.name}` : `native:${tool.name}`;
    const label = toolStepLabel({ name: tool.name });
    if (!`${identity} ${label}`.toLocaleLowerCase().includes(query)) return [];
    const reason = blocked ?? toolBlock ?? (!allowsTool(bot.toolScope, tool) ? "rules" : undefined);
    const status = reason ? "unmounted" : source.notice === "person-dependent" ? "unknown" : "mounted";
    return filter === "all" || filter === status ? [{ id: `${source.id}:${identity}`, label, identity, reason, status }] : [];
  });
}

function sourceRuleBlock(source: BotToolSource, bot: Bot): Reason | undefined {
  if (source.kind === "mcp" && source.name && !canUseMcpServer(bot.toolScope, source.name)) return "rules";
}

function toolRows(bot: Bot, engineKind: string | undefined, directory: Pick<Catalog, "catalog" | "apps" | "discovered">, filter: ToolFilter, query: string): ListRow[] {
  const rulesProblem = toolRulesProblem(bot, engineKind);
  const sources = [...directory.catalog?.sources ?? [], ...directory.apps ?? []];
  const normalQuery = query.trim().toLocaleLowerCase();
  return sources.flatMap((source): ListRow[] => {
    const label = sourceLabel(source);
    const matchesSource = label.toLocaleLowerCase().includes(normalQuery);
    const discovery = source.name && source.kind === "mcp" ? directory.discovered.get(source.name) : undefined;
    const tools = discovery?.loading ? source.tools : discovery?.tools ?? source.tools;
    const groupReason = source.group && bot.toolsOff?.includes(source.group) ? "group-off" : undefined;
    const blocked = groupReason ?? source.blocked ?? rulesProblem;
    const rows = filteredTools(tools, source, bot, matchesSource ? "" : normalQuery, filter, blocked);
    if (!rows.length && (filter !== "all" || !matchesSource)) return [];
    const notice = discovery && !discovery.loading ? discovery.notice : source.notice;
    const reason = blocked ?? sourceRuleBlock(source, bot);
    return [{ id: source.id, label, source, notice, reason, empty: !tools.length, loading: discovery?.loading }, ...rows];
  });
}

function CatalogSourceHeader({ row, groups, off, patch, discover }: {
  row: SourceHeader; groups: readonly ToolGroup[]; off: readonly ToolGroup[];
  patch: (patch: BotPatch) => void; discover: Catalog["discover"];
}) {
  const { source, notice, reason } = row;
  const { group, name } = source;
  const discovery = name && row.empty && source.discover && !row.loading && notice;
  const message = [
    row.empty && reason ? t(REASONS[reason]) : null,
    row.loading ? t("botTools.loading") : notice ? t(NOTICES[notice]) : row.empty && source.discover ? t("botTools.emptySource") : null,
  ].filter(Boolean).join(" · ");
  return <>
    <CardLabel action={group && groups.includes(group) ? (
      <span className="flex items-center touch:min-h-11">
        <Switch className="touch:after:absolute touch:after:inset-x-0 touch:after:-inset-y-2.5"
          aria-label={t("botTools.groupToggle", { name: row.label })} checked={!off.includes(group)} onClick={() =>
            patch({ toolsOff: off.includes(group) ? off.filter((entry) => entry !== group) : [...off, group] })} />
      </span>
    ) : undefined}>
      <span role="heading" aria-level={3} dir="auto" title={row.label}>{row.label}</span>
    </CardLabel>
    {message && (
      <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 pb-2 text-[12px] text-ink-secondary" role={row.loading ? "status" : undefined}>
        <span>{message}</span>
        {discovery && (
          <button type="button" className="ui-button ui-button-sm ui-button-pill touch:min-h-11" onClick={() => discover(name)}>
            {t(notice === "unlisted" ? "botTools.discover" : "connectors.action.retry")}
          </button>
        )}
      </div>
    )}
  </>;
}

export function BotToolList({ bot, engineKind, directory, filter, query, patch, scroll, onRules }: {
  bot: Bot;
  engineKind?: string;
  directory: Catalog;
  filter: ToolFilter;
  query: string;
  patch: (patch: BotPatch) => void;
  scroll: RefObject<HTMLDivElement | null>;
  onRules: (trigger: HTMLElement) => void;
}) {
  const { state } = useStore();
  const off = bot.toolsOff ?? [];
  const groups = shownToolGroups(state.config?.toolGroups, off);
  const { catalog, apps, discovered } = directory;
  const rows = useMemo(() => toolRows(bot, engineKind, { catalog, apps, discovered }, filter, query),
    [bot, engineKind, catalog, apps, discovered, filter, query]);
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroll.current,
    getItemKey: (index) => rows[index]!.id,
    estimateSize: () => 56,
    overscan: 8,
    enabled: rows.length > 150,
  });

  function render(row: ListRow) {
    if ("identity" in row) return (
      <ItemRow
        data-panel-row="tool"
        title={<span className="block truncate" title={row.label}>{row.label}</span>}
        hint={<code className="block break-all text-[12px]" dir="ltr" title={row.identity}>{row.identity}</code>}
      >
        <div className="max-w-[48%] shrink-0 text-end text-[12px] leading-4 text-ink-secondary">
          <div>{t(row.status === "unknown" ? "botTools.status.unknown" : row.status === "unmounted" ? "botTools.filter.unmounted" : "botTools.filter.mounted")}</div>
          {row.reason === "rules" ? (
            <button type="button" className="text-accent-text underline touch:min-h-11" onClick={(event) => onRules(event.currentTarget)}>
              {t(REASONS.rules)}
            </button>
          ) : row.reason && <div>{t(REASONS[row.reason])}</div>}
        </div>
      </ItemRow>
    );
    return <CatalogSourceHeader row={row} groups={groups} off={off} patch={patch} discover={directory.discover} />;
  }

  if (!rows.length) return directory.catalog && <NoteRow>{t("botTools.empty")}</NoteRow>;
  if (rows.length <= 150) return rows.map((row) => <div key={row.id} className="flow-root">{render(row)}</div>);
  return (
    <div className="relative" style={{ height: virtual.getTotalSize() }}>
      {virtual.getVirtualItems().map(({ index, key, start }) => (
        <div ref={virtual.measureElement} key={key} data-index={index} className="absolute inset-x-0 top-0 flow-root"
          style={{ transform: `translateY(${start}px)` }}>
          {render(rows[index]!)}
        </div>
      ))}
    </div>
  );
}
