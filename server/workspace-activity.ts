import type { HandoffView } from "./coordinator.ts";

/** The activity that delays a local workspace switch. */
export interface WorkspaceWork { name: string; what: "bot" | "room" | "sign-in" }

/** The grace period for idle work during workspace switching. */
export const WAIT_CEILING_MS = 30 * 60_000;

/** A hand-off on its way. "waiting" (on the person, or on teammates whose own work is counted by itself) never is. */
const UNDER_WAY: ReadonlySet<HandoffView["status"]> = new Set(["source", "queued", "running", "resume"]);

export interface WorkspaceActivityDeps {
  bots(): ReadonlyArray<{ id: string; name: string }>;
  rooms(): ReadonlyArray<{ id: string; name: string }>;
  /** A turn of this bot's answering now (turn-watchdog.ts `answering`). */
  answering(botId: string): boolean;
  /** Any turn of this bot's under way here: answering, paused, starting, or queued in a room. */
  turn(botId: string): boolean;
  /** The routines' runs; only a running one counts. */
  runs(): ReadonlyArray<{ id: string; botId: string; groupId?: string; status: string }>;
  /** A turn of this room's running or being set up. */
  roomWorking(roomId: string): boolean;
  /** The coordinator's live hand-offs. */
  handoffs(): readonly HandoffView[];
  /** The hand-off's bot and conversation still exist here, as the coordinator checks them before each turn. */
  exists(node: HandoffView): boolean;
  signingIn(): boolean;
  now?(): number;
}

interface Held { key: string; wait: WorkspaceWork; answering?: true }

/** Work that still delays switching the local workspace. */
export function activeWorkspaceWork(deps: WorkspaceActivityDeps): () => WorkspaceWork | null {
  const seen = new Map<string, number>();
  return () => {
    const now = (deps.now ?? Date.now)();
    const bots = new Map(deps.bots().map((bot) => [bot.id, bot]));
    const rooms = new Map(deps.rooms().map((room) => [room.id, room]));
    const found: Held[] = [];
    for (const bot of bots.values()) {
      const wait: WorkspaceWork = { name: bot.name, what: "bot" };
      if (deps.answering(bot.id)) found.push({ key: `answering:${bot.id}`, wait, answering: true });
      else if (deps.turn(bot.id)) found.push({ key: `turn:${bot.id}`, wait });
    }
    for (const run of deps.runs()) {
      if (run.status !== "running") continue;
      const bot = bots.get(run.botId), room = run.groupId === undefined ? undefined : rooms.get(run.groupId);
      if (bot) found.push({ key: `run:${run.id}`, wait: { name: bot.name, what: "bot" } });
      else if (room) found.push({ key: `run:${run.id}`, wait: { name: room.name, what: "room" } });
    }
    for (const room of rooms.values()) if (deps.roomWorking(room.id)) found.push({ key: `room:${room.id}`, wait: { name: room.name, what: "room" } });
    for (const node of deps.handoffs()) {
      const bot = bots.get(node.botId);
      if (bot && UNDER_WAY.has(node.status) && deps.exists(node)) found.push({ key: `handoff:${node.id}`, wait: { name: bot.name, what: "bot" } });
    }
    if (deps.signingIn()) found.push({ key: "sign-in", wait: { name: "", what: "sign-in" } });

    const keys = new Set(found.map((held) => held.key));
    for (const key of seen.keys()) if (!keys.has(key)) seen.delete(key);
    for (const key of keys) if (!seen.has(key)) seen.set(key, now);
    const holding = found.filter((held) => held.answering || now - seen.get(held.key)! < WAIT_CEILING_MS);
    return (holding.find((held) => held.answering) ?? holding[0])?.wait ?? null;
  };
}
