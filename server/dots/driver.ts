import type { ProviderDriver } from "../contracts.ts";
import type { DotsHost } from "./host.ts";

export const DOTS_SELECTION = { instanceId: "dots", model: "dots" };

export function createDotsDriver(host: DotsHost): ProviderDriver {
  const models = { default: "dots", options: [{ id: "dots", label: "Dots" }] };
  return {
    driverKind: "dots", metadata: { displayName: "Dots", supportsMultipleInstances: false }, models,
    decodeConfig: () => ({}), defaultConfig: () => ({}),
    async create({ instanceId }) {
      if (instanceId !== "dots") throw new Error("Dots requires its dedicated instance.");
      return {
        instanceId, driverKind: "dots", displayName: "Dots", enabled: true, models,
        async snapshot() {
          const status = await host.client.status(AbortSignal.timeout(2500));
          return { state: status.authorized ? "available" : "unavailable", authenticated: status.authorized,
            ...(!status.authorized ? { reason: status.connected ? "Dots host authorization required." : "Dots local service is offline." } : {}) };
        },
        adapter: {
          provider: "dots", capabilities: { sessionModelSwitch: "unsupported", images: true },
          async sendTurn() { throw new Error("Dots requires an authorized inbox message or work assignment."); },
          async interruptTurn() {},
          async respondToRequest() { return "unavailable"; },
          hasSession: () => false, async stopAll() {},
          onEvent: () => () => {},
        },
        async dispose() {},
      };
    },
  };
}
