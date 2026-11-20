import type { ServerResponse } from "node:http";
import { z } from "zod";
import type { json } from "../harness/http.ts";

export async function imageJobRoutes(ctx: {
  method: string;
  path: string;
  res: ServerResponse;
  json: typeof json;
  body(): Promise<unknown>;
  device(): string | undefined;
  visible(thread: string): boolean;
  recheck(thread: string, card: string): boolean;
  probe(name: string): Promise<boolean>;
}): Promise<boolean> {
  if (ctx.method !== "POST") return false;
  if (ctx.path === "/api/images/mcp-test") {
    const input = z.object({ name: z.string().min(1).max(128) }).safeParse(await ctx.body());
    const ready = input.success && (await ctx.probe(input.data.name).catch(() => false));
    ctx.json(
      ctx.res,
      ready ? 200 : 400,
      ready ? { ready } : { error: "The connection must provide image_submit, image_status and image_result." },
    );
    return true;
  }
  const match = /^\/api\/threads\/([\w-]+)\/image-jobs\/([\w-]+)\/recheck$/.exec(ctx.path);
  if (!match) return false;
  const changed = ctx.visible(match[1]) && Boolean(ctx.device()) && ctx.recheck(match[1], match[2]);
  ctx.json(ctx.res, changed ? 202 : 404, changed ? { queued: true } : { error: "No image to recheck." });
  return true;
}
