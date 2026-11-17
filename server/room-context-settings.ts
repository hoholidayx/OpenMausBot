import { z } from "zod";

export const roomContextSettings = {
  /** Start a fresh session before a room turn once context reaches this (fraction or tokens); default 0.9. */
  roomCompactAt: z.number().positive().max(10_000_000).optional(),
};
