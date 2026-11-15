import { z } from "zod";
import { supportsModelSystemPrefix, type createModelSystemPrefixes } from "../model-system-prefixes.ts";
import { ownerOrAdmin } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

interface ModelSystemPrefixConnection {
  instanceId: string;
  driverKind: string;
  readOnly: boolean;
}

const prefixBody = z.object({ text: z.string() }).strict();

export function createModelSystemPrefixRoutes({
  prefixes,
  connections,
}: {
  prefixes: Pick<ReturnType<typeof createModelSystemPrefixes>, "read" | "save">;
  connections(): readonly ModelSystemPrefixConnection[];
}): RouteHandler {
  const editableConnections = () => connections().filter((item) => !item.readOnly && supportsModelSystemPrefix(item.driverKind));
  return async ({ req, res, url, path, method, auth, json, readBody }) => {
    if (path !== "/api/model-system-prefixes" || (method !== "GET" && method !== "PUT")) return PASS;
    if (!ownerOrAdmin(auth)) return json(res, 403, { error: "Only an administrator can manage model system prefixes." });
    res.setHeader("cache-control", "no-store");

    const { searchParams } = url;
    if (method === "GET" && !searchParams.has("instanceId") && !searchParams.has("model")) {
      return json(res, 200, { instances: editableConnections().map((item) => item.instanceId) });
    }

    const instanceId = searchParams.get("instanceId");
    const model = searchParams.get("model");
    if (!instanceId?.trim() || !model?.trim()) return json(res, 400, { error: "Choose a connection and enter a model ID." });
    let text: string | undefined;
    if (method === "PUT") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const body = prefixBody.safeParse(await readBody(req, 160 * 1024));
      if (!body.success) return json(res, 400, { error: "Enter a model system prefix as text." });
      text = body.data.text;
    }
    if (!editableConnections().some((item) => item.instanceId === instanceId)) {
      return json(res, 403, { error: "This connection does not support editing model system prefixes." });
    }
    return json(res, 200, { text: text === undefined ? prefixes.read(instanceId, model) : prefixes.save(instanceId, model, text) });
  };
}
