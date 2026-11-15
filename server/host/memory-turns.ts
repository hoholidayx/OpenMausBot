import { roomMemoryCaptureEnabled, type AppConfig } from "../config.ts";
import type { RuntimeEvent } from "../contracts.ts";
import { isInternalTurn } from "../internal-turns.ts";
import { legacyBotMemoryEnabled, legacyMemoryEnabled } from "../legacy-memory.ts";
import type { CaptureTurn, RoomLine } from "../memory-capture.ts";
import { journalTurnWrite } from "../memory-journal.ts";
import { upkeepEnabled, type MemoryUpkeep } from "../memory-upkeep.ts";
import { turnOutcomeLine } from "../recent-work.ts";
import type { BotRecord, GroupRecord, Store } from "../store.ts";
import { extractTurnImages } from "../turn-images.ts";
import { appendMemoryLog, memoryLogPath, memorySourceLabel } from "../workspace.ts";
import type { createCloudTeamHost } from "./cloud-team-host.ts";

const ROOM_CAPTURE_LINES = 12;

interface MemoryTurnHostDeps {
  config: AppConfig;
  store: Pick<Store, "activePath" | "bot" | "botByThread" | "groupByThread" | "messagesFor" | "taskByThread">;
  teamHost: Pick<ReturnType<typeof createCloudTeamHost>, "baseBotId" | "layer" | "ownTurn">;
  cloudHome: boolean;
  cloudPersonal: boolean;
  roomFeedsBot(room: GroupRecord, bot: BotRecord): boolean;
  shouldIgnoreProviderEvent(event: RuntimeEvent): boolean;
  isUnattended(botId: string, threadId: string): boolean;
  cloudOwnerOnlyThread(threadId: string): boolean;
  cloudGuestDriven(threadId: string): boolean;
  routineRunning(threadId: string): boolean;
  goalRunning(threadId: string): boolean;
  failureCause(event: Extract<RuntimeEvent, { type: "turn.completed" }>): string | undefined;
  trustedWrite(botId: string, write: () => void): void;
}

export function createMemoryTurnHost(deps: MemoryTurnHostDeps) {
  const {
    config, store, teamHost, cloudHome, cloudPersonal, roomFeedsBot, shouldIgnoreProviderEvent, isUnattended,
    cloudOwnerOnlyThread, cloudGuestDriven, routineRunning, goalRunning, failureCause, trustedWrite,
  } = deps;

  function captureTurnFor(threadId: string, turnId: string): CaptureTurn | null {
    const path = store.activePath(threadId);
    const replyAt = path.findLastIndex((message) => message.role === "bot" && message.kind === "text" && message.turnId === turnId);
    if (replyAt < 0) return null;
    const asked = path.slice(0, replyAt).findLast((message) => message.role === "user" && message.kind === "text");
    if (!asked || asked.peerAsk) return null;
    return {
      person: extractTurnImages(asked.text ?? "").text,
      bot: path[replyAt]!.text ?? "",
      owner: !asked.sender,
      turnId,
    };
  }

  /** A bot's memory reaches every chat it has, so a room fewer people can see never feeds it. */
  function roomCaptureAllowed(room: GroupRecord, bot: BotRecord | null | undefined): bot is BotRecord {
    if (!bot || !roomMemoryCaptureEnabled(config) || cloudHome || room.dm) return false;
    return room.memberIds.includes(bot.id) && upkeepEnabled(bot) && roomFeedsBot(room, bot);
  }

  function captureRoomTurnFor(threadId: string, botId: string, turnId: string): CaptureTurn | null {
    const path = store.activePath(threadId);
    const replyAt = path.findLastIndex((message) => message.role === "bot" && message.kind === "text" && message.turnId === turnId && message.from?.botId === botId);
    if (replyAt < 0) return null;
    const lastSpoke = path.slice(0, replyAt).findLastIndex((message) => message.role === "bot" && message.kind === "text" && message.from?.botId === botId);
    const lines: RoomLine[] = [];
    for (const message of path.slice(lastSpoke + 1, replyAt)) {
      if (message.kind !== "text" || !message.text?.trim()) continue;
      if (message.role === "user") {
        if (message.peerAsk || message.aside) continue;
        const text = extractTurnImages(message.text).text;
        lines.push(message.sender ? { by: "other", name: message.sender.name, text } : { by: "person", name: "Person", text });
      } else if (message.role === "bot" && message.from && message.from.botId !== botId && !message.webhookPost) {
        lines.push({ by: "peer", name: message.from.name, text: message.text });
      }
    }
    const read = lines.slice(-ROOM_CAPTURE_LINES);
    if (!read.some((line) => line.by !== "peer")) return null;
    return {
      person: read.filter((line) => line.by === "person").map((line) => line.text).join("\n"),
      bot: path[replyAt]!.text ?? "",
      owner: !read.some((line) => line.by === "other"),
      turnId,
      room: read,
    };
  }

  function mayCapture(botId: string, threadId: string): boolean {
    if (cloudGuestDriven(threadId)) return false;
    const room = store.groupByThread(threadId);
    return !room || roomCaptureAllowed(room, store.bot(teamHost.baseBotId(botId)));
  }

  function restoreTurn(botId: string, threadId: string, turnId: string): CaptureTurn | null {
    if (routineRunning(threadId)) return null;
    const room = store.groupByThread(threadId);
    if (room) return roomCaptureAllowed(room, store.bot(botId)) ? captureRoomTurnFor(threadId, botId, turnId) : null;
    if (store.botByThread(threadId)?.id !== botId) return null;
    if (cloudPersonal && !cloudOwnerOnlyThread(threadId)) return null;
    return captureTurnFor(threadId, turnId);
  }

  function noteRoomTurn(room: GroupRecord, threadId: string, turnId: string, noteTurn: MemoryUpkeep["noteTurn"]): void {
    if (!roomMemoryCaptureEnabled(config) || goalRunning(threadId)) return;
    const reply = store.activePath(threadId).findLast(
      (message) => message.role === "bot" && message.kind === "text" && message.turnId === turnId,
    );
    const member = reply?.from ? store.bot(reply.from.botId) : undefined;
    if (!roomCaptureAllowed(room, member) || isUnattended(member.id, threadId)) return;
    const turn = captureRoomTurnFor(threadId, member.id, turnId);
    if (turn) noteTurn(teamHost.layer(member.id, threadId), threadId, turn);
  }

  function captureCompletedTurn(event: RuntimeEvent, noteTurn: MemoryUpkeep["noteTurn"]): void {
    if (!legacyMemoryEnabled || event.type !== "turn.completed" || !event.turnId || !event.ok) return;
    if (shouldIgnoreProviderEvent(event)) return;
    const { threadId, turnId } = event;
    try {
      if (isInternalTurn(threadId) || routineRunning(threadId)) return;
      const room = store.groupByThread(threadId);
      if (room) return noteRoomTurn(room, threadId, turnId, noteTurn);
      const bot = store.botByThread(threadId);
      if (!bot || !upkeepEnabled(bot) || isUnattended(bot.id, threadId)) return;
      if (cloudPersonal && !cloudOwnerOnlyThread(threadId)) return;
      const turn = captureTurnFor(threadId, turnId);
      if (turn) {
        noteTurn(teamHost.layer(bot.id, threadId), threadId, teamHost.ownTurn(threadId) ? { ...turn, owner: true } : turn);
      }
    } catch (error) {
      console.warn(`memory upkeep: could not queue a turn for capture: ${(error as Error).message}`);
    }
  }

  function logCompletedTurn(event: RuntimeEvent): void {
    if (!legacyMemoryEnabled || event.type !== "turn.completed" || !event.turnId) return;
    if (shouldIgnoreProviderEvent(event)) return;
    try {
      const messages = store.messagesFor(event.threadId);
      const reply = messages.findLast((message) => message.role === "bot" && message.kind === "text" && message.turnId === event.turnId);
      const bot = store.botByThread(event.threadId) ?? (reply?.from ? store.bot(reply.from.botId) : undefined);
      if (!bot || !legacyBotMemoryEnabled(bot)) return;
      const tools = messages
        .filter((message) => message.kind === "activity" && message.turnId === event.turnId && message.tool?.name)
        .map((message) => message.tool!.name);
      const line = turnOutcomeLine({ ok: event.ok, reply: reply?.text, stopReason: failureCause(event), tools });
      if (!line) return;
      // A room fewer people can see than this bot leaves no line: session_search would hand it to anyone who sees the bot.
      const room = store.groupByThread(event.threadId);
      if (room && !roomFeedsBot(room, bot)) return;
      if (cloudGuestDriven(event.threadId) || (cloudPersonal && (room || !cloudOwnerOnlyThread(event.threadId)))) return;
      // Lands after this turn's journal diff, so it is journaled here as the turn's own.
      const now = new Date(), layer = teamHost.layer(bot.id, event.threadId);
      const writeLine = () => journalTurnWrite(layer, memoryLogPath(now), event.threadId, () => appendMemoryLog(layer, line, {
        now,
        source: memorySourceLabel({
          room,
          task: store.taskByThread(bot.id, event.threadId),
          threadId: event.threadId,
        }),
      }));
      trustedWrite(bot.id, writeLine);
    } catch {}
  }

  return { mayCapture, restoreTurn, captureCompletedTurn, logCompletedTurn };
}
