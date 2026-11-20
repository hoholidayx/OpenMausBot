import { userError } from "../user-errors.ts";
import { PASS, type RouteContext } from "./table.ts";

export async function retiredTeamRoutes({ method, path, res, json }: RouteContext): Promise<typeof PASS | void> {
  if (path === "/api/me" || path === "/api/me/welcome" || (method === "GET" && /^\/api\/team\/people\/p_[\w-]{22}\/picture$/.test(path))) {
    return json(res, 404, { error: "not found" });
  }
  if ((method === "GET" && path === "/api/team/people") ||
      (method === "PUT" && (path === "/api/team/reports-to" || /^\/api\/bots\/[\w-]{1,128}\/reports-to$/.test(path)))) {
    return json(res, 400, userError("serverError.owner.teamOnly"));
  }
  return PASS;
}
