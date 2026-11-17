import { DRAIN_COALESCE_MAX_ITEMS } from "../admission.ts";
import type { ContextMessage } from "../delta-context.ts";
import { digestPromptLine } from "../digest.ts";
import { escapeNotes, peerProvenanceNote, webhookPostNote } from "../peer-provenance.ts";
import { lineNote } from "../provenance-label.ts";
import { peerName } from "../peer-roster.ts";
import { roomReactionNote } from "../reactions.ts";
import { speakerOf, transcriptText, type PersonName } from "../replies.ts";
import { roomTurnNarrationIds } from "../room-reply.ts";
import type { Message, Store } from "../store.ts";

export const GROUP_CONTEXT_MESSAGES = DRAIN_COALESCE_MAX_ITEMS;

export interface RoomLine extends ContextMessage {
  readonly assistantText?: string;
  readonly promptText?: string;
  requestId?: string;
  turnId?: string;
}

export function isRoomContextMessage(m: Pick<Message, "kind" | "text" | "digest" | "roomRequest">): boolean {
  return Boolean((m.kind === "text" && m.text) || (m.kind === "digest" && m.digest) || m.roomRequest?.phase === "result");
}

function hasRoomContext(message: Message, botId: string): boolean {
  const digest = message.digest;
  if (message.kind !== "digest" || digest?.botId !== botId) return isRoomContextMessage(message);
  return Boolean(digest.tools.length || digest.toolsDropped || digest.files);
}

export interface RoomTranscriptDeps {
  store: Pick<Store, "activePath">;
  teammateReportContext(requestId: string, readerBotId?: string): string;
}

export function createRoomTranscript({ store, teammateReportContext }: RoomTranscriptDeps) {
  function read(threadId: string, userName: PersonName, botId: string, overrides?: ReadonlyMap<string, string>): RoomLine[] {
    const messages = store.activePath(threadId);
    const messagesById = new Map(messages.map((message) => [message.id, message]));
    const narration = roomTurnNarrationIds(messages);
    const render = (m: Message) => {
      if (m.kind === "digest" && m.digest) {
        const digest = m.digest.botId === botId ? { ...m.digest, reply: "" } : m.digest;
        return digestPromptLine(digest, m.from ? peerName(m.from.name) : "a bot");
      }
      const person = speakerOf(userName, m);
      const speaker = m.role === "user" ? person : m.from ? peerName(m.from.name) : "Bot";
      const body = escapeNotes(transcriptText(m, messagesById, userName));
      if (m.webhookPost && m.role === "bot") return `${webhookPostNote(m.from?.name ?? "Bot")}\n${speaker}: ${JSON.stringify(body)}`;
      const note = lineNote(m, { shared: false, name: () => person });
      const suffix = roomReactionNote(m, userName);
      if (note) return `${note}\n${speaker}: ${JSON.stringify(body)}${suffix}`;
      const line = `${speaker}: ${body}${suffix}`;
      if (!m.peerPost || !m.from || m.from.botId === botId) return line;
      return `${peerProvenanceNote({ botName: m.from.name, delivery: "post_to_room", unattended: m.peerPost.unattended })}\n${line}`;
    };
    return messages.filter(m => !narration.has(m.id) && hasRoomContext(m, botId)).flatMap((m): RoomLine[] => {
      if (m.roomRequest?.phase === "result") {
        const text = teammateReportContext(m.roomRequest.id, botId);
        return text ? [{ id: m.id, role: "user", text, requestId: m.roomRequest.id }] : [];
      }
      const ownReply = m.role === "bot" && m.kind === "text" && m.turnId && m.from?.botId === botId && !m.peerPost && !m.webhookPost;
      const override = overrides?.get(m.id);
      return [{
        id: m.id, role: ownReply ? "assistant" : "user", get text() { return render(m); },
        turnId: ownReply ? m.turnId : undefined,
        get assistantText() { return ownReply ? transcriptText(m, messagesById, userName) : undefined; },
        get promptText() { return override === undefined ? undefined : render({ ...m, text: override }); },
        ...(m.steered ? { steered: true } : {}),
      }];
    });
  }

  return { read };
}
