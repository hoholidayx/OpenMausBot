import type { ModelCatalog } from "./contracts.ts";
import { contextWindowFor } from "./context-budget.ts";

export type RoomMemberContext = { tokens: number; window: number };

type Measured = RoomMemberContext & { at: number };

export type RoomContextClock = {
  idleMs?: number;
  heldUntil?: (threadId: string) => number | undefined;
  now?: () => number;
  expired?: (threadId: string) => void;
};

export class RoomContextTracker {
  private threads = new Map<string, Map<string, Measured>>();
  private readonly clock: RoomContextClock;
  private readonly idleMs: number;

  constructor(clock: RoomContextClock = {}) {
    this.clock = clock;
    this.idleMs = clock.idleMs ?? 30 * 60_000;
  }

  record(threadId: string, botId: string, reading: { tokens?: number; window?: number } | undefined, model: string | undefined, catalog?: ModelCatalog): void {
    const tokens = reading?.tokens;
    if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0) return;
    const members = this.threads.get(threadId) ?? new Map<string, Measured>();
    const measured: Measured = {
      tokens: Math.trunc(tokens),
      window: contextWindowFor(model, catalog, reading?.window),
      at: this.now(),
    };
    members.set(botId, measured);
    this.threads.set(threadId, members);
    this.watch(threadId, botId, measured);
  }

  forThread(threadId: string): Record<string, RoomMemberContext> | undefined {
    const members = this.threads.get(threadId);
    if (!members) return undefined;
    for (const botId of members.keys()) this.live(threadId, botId);
    if (!members.size) return undefined;
    return Object.fromEntries([...members].map(([botId, { tokens, window }]) => [botId, { tokens, window }]));
  }

  forget(threadId: string): void {
    this.threads.delete(threadId);
  }

  clear(threadId: string, botId: string): boolean {
    const members = this.threads.get(threadId);
    if (!members?.delete(botId)) return false;
    if (!members.size) this.threads.delete(threadId);
    return true;
  }

  private now(): number {
    return this.clock.now?.() ?? Date.now();
  }

  private warmUntil(threadId: string, reading: Measured): number {
    return Math.max(reading.at + this.idleMs, this.clock.heldUntil?.(threadId) ?? 0);
  }

  private watch(threadId: string, botId: string, reading: Measured): void {
    const expired = this.clock.expired;
    if (!expired) return;
    const check = () => {
      if (this.threads.get(threadId)?.get(botId) !== reading) return;
      if (this.live(threadId, botId)) return arm(this.warmUntil(threadId, reading) - this.now());
      expired(threadId);
    };
    const arm = (ms: number) => {
      const timer = setTimeout(check, Math.min(2_147_483_647, Math.max(0, ms)));
      timer.unref?.();
    };
    arm(this.warmUntil(threadId, reading) - this.now());
  }

  private live(threadId: string, botId: string): Measured | undefined {
    const members = this.threads.get(threadId);
    const current = members?.get(botId);
    if (!members || !current) return undefined;
    if (this.now() < this.warmUntil(threadId, current)) return current;
    members.delete(botId);
    if (!members.size) this.threads.delete(threadId);
    return undefined;
  }
}
