import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { messageFileDisposition } from "../message-file.ts";
import { PASS, type RouteHandler } from "../routes/table.ts";
import type { RequestAuth } from "../request-auth.ts";
import { DotsHttpError } from "./client.ts";
import type { DotsHost } from "./host.ts";
import type { connectDots } from "./maus.ts";

export function dotsRoutes(host: DotsHost, binding: ReturnType<typeof connectDots>, owner: (auth: RequestAuth) => boolean,
  visible: (auth: RequestAuth, thread: string) => boolean): RouteHandler {
  return async ({ path, method, auth, res, json }) => {
    if (method !== "GET") return PASS;
    if (path === "/api/dots/status" && owner(auth)) return json(res, 200, await host.client.status(AbortSignal.timeout(2500)));
    const match = /^\/api\/threads\/([\w-]+)\/messages\/([\w-]+)\/dots-files\/([\w-]+)$/.exec(path);
    if (!match) return PASS;
    const [, thread, message, id] = match;
    const file = owner(auth) && visible(auth, thread!) && binding.file(thread!, message!, id!);
    if (!file) return json(res, 404, { error: "Attachment unavailable." });
    if (file.status !== "ready") return json(res, file.status === "pending" ? 409 : 410, { error: file.status });
    const abort = new AbortController();
    res.once("close", () => abort.abort());
    try {
      const response = await host.client.download(id!, abort.signal);
      if (!response.body) return json(res, 502, { error: "Dots returned an empty download." });
      res.setHeader("content-type", "application/octet-stream");
      res.setHeader("content-disposition", messageFileDisposition(file.name));
      res.setHeader("cache-control", "no-store");
      for (const key of ["content-length", "x-content-sha256"]) {
        const value = response.headers.get(key);
        if (value) res.setHeader(key, value);
      }
      await pipeline(Readable.fromWeb(response.body), res, { signal: abort.signal });
    } catch (error) {
      if (!res.headersSent && !res.destroyed) return json(res, error instanceof DotsHttpError && error.status === 404 ? 404 : 502, { error: "Dots attachment unavailable." });
    }
  };
}
