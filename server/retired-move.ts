import { existsSync } from "node:fs";
import { join } from "node:path";

import type { BotRecord } from "./store.ts";

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const RECOVERY_API = /^\/api\/(?:auth|workspace-backup)(?:\/|$)/;
const COPY_MESSAGE = "This workspace was moved. Export a workspace backup to recover its data.";

function movedError(message: string): Error {
  return Object.assign(new Error(message), { status: 409, code: "moved" });
}

export function retiredWorkspaceCopy(dataDir: string) {
  const frozen = existsSync(join(dataDir, "moved.json"));
  return {
    frozen: () => frozen,
    refusal: () => frozen ? COPY_MESSAGE : null,
    assertTurns() {
      if (frozen) throw movedError(COPY_MESSAGE);
    },
    refuses(method: string, path: string): string | null {
      return frozen && !READ_METHODS.has(method) && !RECOVERY_API.test(path) ? COPY_MESSAGE : null;
    },
  };
}

export function retiredBotMessage(bot: Pick<BotRecord, "name" | "movedTo"> | null | undefined): string | null {
  return bot?.movedTo ? `${bot.name} is a local copy from a move to ${bot.movedTo.team.name}.` : null;
}

export function assertBotHere(bot: Pick<BotRecord, "name" | "movedTo"> | null | undefined): void {
  const message = retiredBotMessage(bot);
  if (message) throw movedError(message);
}
