import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { migrateSharedMemory } from "../server/bot-memory-migration.ts";

try {
  const { values, positionals: [action, ...extra] } = parseArgs({ allowPositionals: true, options: {
    "data-dir": { type: "string" }, endpoint: { type: "string" },
  } });
  if (!values["data-dir"] || !values.endpoint || extra.length || (action !== "inspect" && action !== "disable" && action !== "restore")) {
    throw new Error("Usage: node scripts/bot-memory-legacy.ts inspect|disable|restore --data-dir PATH --endpoint URL");
  }
  const result = await migrateSharedMemory(resolve(values["data-dir"]), values.endpoint, action);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : "The memory migration could not finish.");
  process.exitCode = 1;
}
