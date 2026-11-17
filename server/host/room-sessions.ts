import { createHash } from "node:crypto";

import { replayOmission, selectReplay, type ReplayEntry } from "../context-rebuild.ts";
import type { RuntimeEvent, SendTurnInput } from "../contracts.ts";
import { HANDED_MAX_IDS, Handoffs, handedStateUsable, sessionStart, unseenMessages, type HandedState, type HandoffStore } from "../delta-context.ts";
import type { RoomSessionReceipt, RoomSessionStore } from "./room-session-store.ts";
import { GROUP_CONTEXT_MESSAGES, type RoomLine } from "./room-transcript.ts";

export const ROOM_DELTA_NOTE = "[Messages this conversation received since your last turn in this room, oldest first.]";
export const ROOM_DELTA_NONE = "[Messages this conversation received since your last turn in this room: none.]";

export interface RoomDispatchInput {
  threadId: string;
  botId: string;
  claimId: string;
  instanceId: string;
  fingerprint: string;
  resumable(): boolean;
  current(): boolean;
  reset: boolean;
  stateless: boolean;
  budgetBytes: number;
  lines: RoomLine[];
  required: ReadonlySet<string>;
  wrap(body: string, context: string, reports: ReadonlySet<string>): string;
  onAccepted(): void;
}

interface Packet {
  body: string;
  current: string;
  history: ReplayEntry[];
  ids: string[];
  required: string[];
  reports: ReadonlySet<string>;
  overflow: boolean;
}

function lineText(line: RoomLine): string {
  const text = line.promptText ?? line.text;
  return line.steered ? "[Sent while an earlier turn was running. It may have reached you then.]\n" + text : text;
}

function pack(lines: readonly RoomLine[], required: ReadonlySet<string>, budgetBytes: number): Packet {
  const optional = lines.filter(line => !required.has(line.id));
  const entries = optional.slice(-GROUP_CONTEXT_MESSAGES).map(line => ({ id: line.id, role: line.role, get text() { return lineText(line); } }));
  const replay = selectReplay(entries, { budgetBytes, maxMessages: GROUP_CONTEXT_MESSAGES });
  const historyLines = replay.transcript.filter(entry => entry.id);
  const dropped = replay.dropped + optional.length - entries.length;
  const omission = replayOmission(dropped);
  const history = new Map(historyLines.map(entry => [entry.id, entry.text]));
  const sent = lines.filter(line => required.has(line.id) || history.has(line.id));
  const current = sent.filter(line => required.has(line.id));
  return {
    body: [...omission.map(entry => entry.text), ...sent.map(line => history.get(line.id) ?? lineText(line))].join("\n"),
    current: current.map(lineText).join("\n"),
    history: [...omission, ...historyLines],
    ids: sent.map(line => line.id),
    required: current.map(line => line.id),
    reports: new Set(current.flatMap(line => line.requestId ? [line.requestId] : [])),
    overflow: dropped > 0 || replay.shortened.length > 0,
  };
}

function lineVersion(line: RoomLine): string {
  return JSON.stringify([line.id, line.role, line.text, line.steered ?? false]);
}

function receivedHistory(state: HandedState, earlier: readonly string[], lines: readonly RoomLine[]): string | undefined {
  const order = lines.map(line => line.id);
  if (!handedStateUsable(state, state.session, order)) return undefined;
  const positions = new Map(order.map((id, index) => [id, index]));
  const sparse = new Set([...state.ids, ...earlier]);
  if ([...sparse].some(id => !positions.has(id))) return undefined;
  const omitted = state.omitted === undefined ? -1 : positions.get(state.omitted)!;
  const through = state.through === undefined ? omitted : positions.get(state.through)!;
  if (through < omitted) return undefined;
  const hash = createHash("sha256");
  lines.forEach((line, index) => {
    if ((index > omitted && index <= through) || sparse.has(line.id)) hash.update(lineVersion(line));
  });
  return hash.digest("hex");
}

function unseenRoomLines(lines: RoomLine[], order: string[], required: ReadonlySet<string>, receipt: RoomSessionReceipt): RoomLine[] {
  const unseen = new Set(unseenMessages(lines, order, receipt.handed).map(line => line.id));
  const omitted = receipt.handed.omitted === undefined ? -1 : order.indexOf(receipt.handed.omitted);
  const earlier = new Set(receipt.earlier);
  return lines.filter((line, index) => unseen.has(line.id) || (index <= omitted && required.has(line.id) && !earlier.has(line.id)));
}

function sentVersions(lines: RoomLine[], packet: Packet): Map<string, string> {
  const sent = new Set(packet.ids);
  return new Map(lines.filter(line => sent.has(line.id)).map(line => [line.id, lineVersion(line)]));
}

function asTranscript(history: readonly ReplayEntry[], lines: readonly RoomLine[]): NonNullable<SendTurnInput["transcript"]> {
  const map = new Map(lines.map(line => [line.id, line]));
  return history.map(entry => {
    const original = map.get(entry.id);
    const own = entry.role === "assistant" && original?.text === entry.text ? original.assistantText : undefined;
    return { role: entry.role, text: own ?? entry.text };
  });
}

interface Flight {
  input: RoomDispatchInput;
  turnId?: string;
  session?: string;
  rebuilt?: boolean;
  distrusted?: "compacted" | "invalid";
  previous?: RoomSessionReceipt;
  handed?: HandedState;
  start: Map<string, string>;
  delta?: Map<string, string>;
  lines: RoomLine[];
}

type CompletedTurn = Extract<RuntimeEvent, { type: "turn.completed" }>;

export function createRoomSessions(deps: {
  store: RoomSessionStore;
  read(threadId: string, botId: string): RoomLine[];
  interrupt(threadId: string, turnId: string | undefined): void;
}) {
  const flights = new Map<string, Flight>();
  const land = (threadId: string) => {
    flights.delete(threadId);
    handoffs.forget(threadId);
  };

  const staging: HandoffStore = {
    order: threadId => flights.get(threadId)?.lines.map(line => line.id) ?? [],
    read(_botId, threadId) { return flights.get(threadId)?.handed; },
    write(_botId, threadId, _instanceId, handed) {
      const flight = flights.get(threadId);
      if (flight) flight.handed = handed;
    },
    replies: (threadId, turnId) => flights.get(threadId)?.lines.filter(line => line.turnId === turnId).map(line => line.id) ?? [],
  };
  const handoffs = new Handoffs(staging);

  function dispatch(input: RoomDispatchInput): Pick<SendTurnInput, "text" | "resumeCursor" | "sessionReset" | "recoveryText" | "transcript"> {
    const { threadId, botId, claimId, lines, required } = input;
    land(threadId);
    // A crash may leave the native session ahead of its last confirmed position.
    const consumed = deps.store.take(threadId, botId);
    const order = lines.map(line => line.id);
    const cold = pack(lines, required, input.budgetBytes);
    const previous = resumableReceipt(input, consumed);
    const next = previous && pack(unseenRoomLines(lines, order, required, previous), required, input.budgetBytes);
    const delta = next && !next.overflow ? next : undefined;
    const cursor = delta ? previous?.handed.session : undefined;
    const start = sessionStart(order, cold.history.filter(line => line.id).map(line => line.id), cold.required);
    const flight: Flight = {
      input, lines, previous: cursor ? previous : undefined, handed: cursor ? previous?.handed : undefined,
      start: sentVersions(lines, cold), delta: delta && sentVersions(lines, delta),
    };
    const fresh = input.wrap(input.stateless ? cold.current : cold.body, cold.body, cold.reports);
    const body = delta?.body ? ROOM_DELTA_NOTE + "\n" + delta.body : ROOM_DELTA_NONE;
    const turn = cursor && delta
      ? { text: input.wrap(body, delta.body, delta.reports), resumeCursor: cursor, recoveryText: fresh }
      : { text: fresh, sessionReset: true, ...(input.stateless ? { transcript: asTranscript(cold.history, lines) } : {}) };
    flights.set(threadId, flight);
    handoffs.begin(threadId, claimId, {
      botId, instanceId: input.instanceId, resumeCursor: cursor, config: input.fingerprint,
      started: start, recovery: start, resumed: start, placed: delta?.ids ?? [], carried: [], own: [],
    });
    handoffs.dispatching(threadId, claimId);
    return turn;
  }

  function resumableReceipt(input: RoomDispatchInput, receipt: RoomSessionReceipt | undefined): RoomSessionReceipt | undefined {
    if (!receipt || input.reset || !input.resumable() || receipt.instanceId !== input.instanceId || receipt.fingerprint !== input.fingerprint) return undefined;
    if (receivedHistory(receipt.handed, receipt.earlier, input.lines) !== receipt.history) return undefined;
    return receipt;
  }

  function bindTurn(threadId: string, claimId: string, turnId: string | undefined): void {
    const flight = flights.get(threadId);
    if (flight?.input.claimId !== claimId) return;
    flight.turnId ??= turnId;
    handoffs.bindTurn(threadId, claimId, turnId);
  }

  function matches(flight: Flight | undefined, event: RuntimeEvent): flight is Flight {
    return Boolean(flight?.turnId && flight.turnId === event.turnId && flight.input.instanceId === event.providerInstanceId);
  }

  function observe(event: RuntimeEvent): void {
    const flight = flights.get(event.threadId);
    if (!flight || event.type === "turn.completed") return;
    if (event.type === "turn.started" && event.providerInstanceId === flight.input.instanceId) {
      bindTurn(event.threadId, flight.input.claimId, event.turnId);
    }
    if (!matches(flight, event) || flight.distrusted) return;
    if (event.type === "session.started" && event.sessionId) {
      if (!observeSession(flight, event.sessionId, event.rebuilt === true)) return;
    }
    if (event.type === "context.compacted") { flight.distrusted = "compacted"; return; }
    handoffs.onEvent(event);
  }

  function observeSession(flight: Flight, session: string, rebuilt: boolean): boolean {
    const { threadId, botId, instanceId } = flight.input;
    const cursor = flight.previous?.handed.session;
    const expected = cursor === undefined || session === cursor || rebuilt || flight.session === session;
    let verified = false;
    try {
      verified = expected && !claimedByAnotherTurn(flight, session) && !deps.store.ownsElsewhere(threadId, botId, instanceId, session);
    } catch (error) {
      console.warn("room context: could not verify the native session", error instanceof Error ? error.message : String(error));
    }
    if (!verified) {
      flight.distrusted = "invalid";
      deps.interrupt(threadId, flight.turnId);
      return false;
    }
    if (flight.session !== session) {
      flight.session = session;
      flight.rebuilt = rebuilt;
    }
    return true;
  }

  function claimedByAnotherTurn(flight: Flight, session: string): boolean {
    for (const other of flights.values()) {
      if (other === flight || other.input.instanceId !== flight.input.instanceId) continue;
      if ((other.session ?? other.previous?.handed.session) === session) return true;
    }
    return false;
  }

  function save(flight: Flight): void {
    const { input, handed, previous, lines } = flight;
    if (flight.distrusted || !input.resumable() || !handed?.session) return;
    if (flight.session !== undefined && handed.session !== flight.session) return;
    const resumed = previous !== undefined && flight.rebuilt !== true && handed.session === previous.handed.session;
    const byId = new Map(lines.map(line => [line.id, line]));
    const sent = resumed ? flight.delta : flight.start;
    if (!sent || [...sent].some(([id, version]) => {
      const line = byId.get(id);
      return !line || lineVersion(line) !== version;
    })) return;
    if (resumed && receivedHistory(previous.handed, previous.earlier, lines) !== previous.history) return;
    const omitted = lines.findIndex(line => line.id === handed.omitted);
    const early = new Set(resumed ? previous.earlier : []);
    for (const line of lines.slice(0, omitted + 1)) if (sent.has(line.id)) early.add(line.id);
    if (early.size > HANDED_MAX_IDS) return;
    const earlier = [...early];
    const history = receivedHistory(handed, earlier, lines);
    if (history === undefined) return;
    deps.store.save(input.threadId, input.botId, {
      version: 1, instanceId: input.instanceId, fingerprint: input.fingerprint, handed: { ...handed, session: handed.session }, earlier, history,
    });
  }

  function complete(event: CompletedTurn, stopped: boolean): void {
    const flight = flights.get(event.threadId);
    if (!matches(flight, event)) return;
    try {
      if (!event.ok || stopped || event.stopReason === "cancelled" || flight.distrusted === "invalid" || !flight.input.current()) return;
      flight.lines = deps.read(event.threadId, flight.input.botId);
      handoffs.onEvent(event);
      save(flight);
      flight.input.onAccepted();
    } catch (error) {
      console.warn("room context: could not save the completed turn", error instanceof Error ? error.message : String(error));
    } finally { land(event.threadId); }
  }

  return {
    dispatch, bindTurn, observe, complete,
    abandon(threadId: string, claimId: string) {
      if (flights.get(threadId)?.input.claimId === claimId) land(threadId);
    },
    distrust(threadId: string, botId: string, reason: NonNullable<Flight["distrusted"]> = "invalid") {
      deps.store.forget(threadId, botId);
      const flight = flights.get(threadId);
      if (flight?.input.botId === botId && flight.distrusted !== "invalid") flight.distrusted = reason;
    },
    forget(threadId: string) {
      deps.store.forget(threadId);
      land(threadId);
    },
    forgetBot(botId: string) {
      deps.store.forgetBot(botId);
      for (const [threadId, flight] of flights) if (flight.input.botId === botId) land(threadId);
    },
    forgetInstance(instanceId: string) {
      deps.store.forgetInstance(instanceId);
      for (const [threadId, flight] of flights) if (flight.input.instanceId === instanceId) land(threadId);
    },
  };
}
