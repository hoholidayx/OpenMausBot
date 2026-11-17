import { useEffect, useRef, useState } from "react";
import { api, type Bot } from "@/state/store";
import type { BotToolCatalog, BotToolEntry, BotToolNotice, BotToolSource } from "../../../shared/bot-tool-catalog";

type Discovery = { loading: true } | { loading?: false; tools?: BotToolEntry[]; notice?: BotToolNotice };

export function useBotToolCatalog(bot: Bot) {
  const [catalog, setCatalog] = useState<BotToolCatalog>();
  const [apps, setApps] = useState<BotToolSource[]>();
  const [error, setError] = useState(false);
  const [appsError, setAppsError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [appRevision, setAppRevision] = useState(0);
  const [discovered, setDiscovered] = useState<ReadonlyMap<string, Discovery>>(() => new Map());
  const requests = useRef(new Map<string, AbortController>());
  const url = `/api/bots/${bot.id}/tool-catalog`;
  const configuresApps = catalog?.apps === true;

  useEffect(() => {
    const controller = new AbortController();
    setError(false);
    void api<BotToolCatalog>(url, { signal: controller.signal })
      .then((value) => { if (!controller.signal.aborted) setCatalog(value); })
      .catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [url, revision, bot.modelSelection.instanceId, bot.mcpServers, bot.browser, bot.browserProfile, bot.computer,
    bot.connectorScopes, bot.connectorTools, bot.composio, bot.xResearch]);

  useEffect(() => {
    if (!configuresApps) return;
    const controller = new AbortController();
    setAppsError(false);
    void api<{ sources: BotToolSource[] }>(`${url}/apps`, { signal: controller.signal })
      .then((value) => { if (!controller.signal.aborted) setApps(value.sources); })
      .catch(() => { if (!controller.signal.aborted) setAppsError(true); });
    return () => controller.abort();
  }, [url, configuresApps, appRevision, bot.modelSelection.instanceId, bot.connectorScopes, bot.connectorTools, bot.composio]);

  useEffect(() => {
    const active = requests.current;
    return () => {
      for (const controller of active.values()) controller.abort();
      active.clear();
    };
  }, []);

  function discover(name: string) {
    if (requests.current.has(name)) return;
    const controller = new AbortController();
    requests.current.set(name, controller);
    const update = (result: Discovery) => setDiscovered((before) => new Map(before).set(name, result));
    update({ loading: true });
    void api<Exclude<Discovery, { loading: true }>>(`${url}/mcp/${encodeURIComponent(name)}`, { method: "POST", signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) update(result);
      })
      .catch(() => {
        if (!controller.signal.aborted) update({ notice: "connection-failed" });
      })
      .finally(() => { if (requests.current.get(name) === controller) requests.current.delete(name); });
  }

  return {
    catalog, apps: configuresApps ? apps : undefined, error, appsError, discovered, discover,
    retry: () => setRevision((value) => value + 1),
    retryApps: () => setAppRevision((value) => value + 1),
  };
}
