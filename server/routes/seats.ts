import { PASS, type RouteHandler } from "./table.ts";

export function createSeatsRoutes(): RouteHandler {
  return async ({ res, path, method, json }) => {
    if (path !== "/api/seats" || method !== "GET") return PASS;
    return json(res, 200, { seats: 1 });
  };
}
