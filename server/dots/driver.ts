import { newEventId, type ProviderDriver, type RuntimeEvent, type RuntimeEventListener } from "../contracts.ts";
import type { DotsHost } from "./host.ts";

export const DOTS_SELECTION = { instanceId: "dots", model: "dots" };

export function createDotsDriver(host: DotsHost): ProviderDriver {
  const models = { default: "dots", options: [{ id: "dots", label: "Dots" }] };
  return {
    driverKind: "dots", metadata: { displayName: "Dots", supportsMultipleInstances: false }, models,
    decodeConfig: () => ({}), defaultConfig: () => ({}),
    async create({ instanceId }) {
      if (instanceId !== "dots") throw new Error("Dots requires its dedicated instance.");
      const listeners = new Set<RuntimeEventListener>();
      const active = new Map<string, { id: string; stop: AbortController }>();
      const emit = (event: RuntimeEvent) => { for (const listener of listeners) listener(event); };
      const stopAll = async () => { for (const item of active.values()) item.stop.abort(); };
      return {
        instanceId, driverKind: "dots", displayName: "Dots", enabled: true, models,
        async snapshot() {
          const status = await host.client.status(AbortSignal.timeout(2500));
          return { state: status.authorized ? "available" : "unavailable", authenticated: status.authorized,
            ...(!status.authorized ? { reason: status.connected ? "Dots host authorization required." : "Dots local service is offline." } : {}) };
        },
        adapter: {
          provider: "dots", capabilities: { sessionModelSwitch: "unsupported", images: true },
          async sendTurn({ dots: turn, botId, threadId }) {
            if (!turn || turn.parent || botId !== host.inbox.botId || threadId !== host.inbox.threadId || threadId !== turn.threadId || active.has(threadId)) {
              throw new Error("Dots requires an authorized direct message in its own inbox.");
            }
            const stop = new AbortController(), turnId = turn.id;
            const base = () => ({ threadId, turnId, provider: "dots", eventId: newEventId(), createdAt: new Date().toISOString() });
            host.inbox.enqueue(turn);
            active.set(threadId, { id: turnId, stop });
            emit({ ...base(), type: "turn.started" });
            void host.run(turn, stop.signal).catch(() => ({ ok: false, text: "Dots inbox unavailable." })).then(outcome => {
              active.delete(threadId);
              emit({ ...base(), type: "turn.completed", ok: outcome.ok, stopReason: stop.signal.aborted ? "interrupted" : outcome.ok ? null : outcome.text });
            });
            return { turnId };
          },
          async interruptTurn(threadId, turnId) {
            const item = active.get(threadId);
            if (item && (!turnId || turnId === item.id)) item.stop.abort();
          },
          async respondToRequest() { return "unavailable"; },
          hasSession: threadId => active.has(threadId), stopAll,
          onEvent(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        },
        dispose: stopAll,
      };
    },
  };
}
