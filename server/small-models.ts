import { readFileSync } from "node:fs";
import type { ModelCatalog } from "./contracts.ts";
import { writeFileAtomic } from "./atomic.ts";

const FAST = /(^|[-_/. ])(haiku|flash|mini|nano|lite|small|fast|instant|spark|turbo|air)(?=$|[-_/. \d])/i;

/** Same upstream provider only; among several, the first listed wins since engines list their newest first. */
export function fastModelFor(catalog: ModelCatalog | undefined, current: string, refused: ReadonlySet<string> = new Set()): string | undefined {
  if (!catalog) return undefined;
  if (FAST.test(current)) return current;
  const provider = catalog.options.find((option) => option.id === current)?.provider;
  const pick = catalog.options.find((option) => !option.custom && !refused.has(option.id) &&
    FAST.test(option.id) && (option.provider ?? undefined) === (provider ?? undefined));
  return pick?.id;
}

const MODEL_REFUSED = /\b(?:400|404)\b|invalid_request_error|model_not_found|not supported|unsupported|not available|does not exist|may not exist|not have access|unknown model|invalid model|no such model|not found/i;

/** A model-unsupported or invalid-model answer that names `model`. */
export function refusesModel(message: string | null | undefined, model: string): boolean {
  if (!message || !MODEL_REFUSED.test(message)) return false;
  return [model, model.split("::").at(-1), model.split("/").at(-1)].some((name) => name && message.includes(name));
}

const NONE: ReadonlySet<string> = new Set();

function load(file: string): Map<string, Set<string>> {
  try {
    const rows = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!rows || typeof rows !== "object" || Array.isArray(rows)) return new Map();
    return new Map(Object.entries(rows).flatMap(([instanceId, models]) => Array.isArray(models)
      ? [[instanceId, new Set(models.filter((model): model is string => typeof model === "string"))] as const] : []));
  } catch {
    return new Map();
  }
}

export class RefusedModels {
  private readonly values: Map<string, Set<string>>;
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
    this.values = load(file);
  }

  refused(instanceId: string): ReadonlySet<string> {
    return this.values.get(instanceId) ?? NONE;
  }

  remember(instanceId: string, model: string): void {
    const models = this.values.get(instanceId) ?? new Set<string>();
    if (models.has(model)) return;
    models.add(model);
    this.values.set(instanceId, models);
    try {
      writeFileAtomic(this.file, JSON.stringify(Object.fromEntries([...this.values].map(([id, refused]) => [id, [...refused]]))), { mode: 0o600 });
    } catch (error) {
      console.warn(`refused quick models not saved: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
