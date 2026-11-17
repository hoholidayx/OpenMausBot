import { join } from "node:path";

import { DATA_DIR } from "./config.ts";

export function journalFile(botId: string): string {
  return join(DATA_DIR, "memory-journal", `${botId}.ndjson`);
}
