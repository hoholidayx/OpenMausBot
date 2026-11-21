import { requestConflict } from "../guarded-requests.ts";
import { slimMessage } from "../host/message-pages.ts";
import { appendAtRequest } from "../host/work-partner.ts";
import { settleChatFollowups, type ChatFollowup } from "../message-db.ts";
import type { Message, Store } from "../store.ts";
import { dotsInput, DotsInputError } from "./files.ts";
import type { DotsHost, DotsProjection } from "./host.ts";

interface DirectOptions {
  sendId?: string;
  sender?: Message["sender"];
  dataContext?: Message["dataContext"];
  replyTo?: { id: string };
  editedMessageId?: string;
  userMessage?: Message;
  queueId?: string;
}

export function directDotsMessages(host: DotsHost, store: Store, available: () => boolean, complete: DotsProjection["complete"]) {
  const { inbox } = host;
  const { botId, threadId } = inbox;
  const legacy: ChatFollowup[] = [];

  function send(text: string, opts: DirectOptions = {}) {
    const raw = opts.userMessage?.text ?? text;
    const body = dotsInput(raw);
    const enqueue = (source: Message) => {
      if (!inbox.authorized(threadId, source)) throw Object.assign(new Error("Dots message was not authorized by its owner."), { status: 403 });
      const id = "direct-" + source.id;
      const rootId = inbox.get(id)?.turn.rootId ?? id;
      inbox.enqueue({ id, rootId, threadId, sourceId: source.id, ...body });
    };
    let message = opts.userMessage;
    if (message) {
      enqueue(message);
    } else if (opts.editedMessageId) {
      const edited = store.branchMessage(threadId, opts.editedMessageId, raw, opts.sendId, opts.sender, opts.dataContext, enqueue);
      if (!edited) throw requestConflict("The original Dots message is unavailable.");
      message = edited;
    } else {
      message = store.appendMessage(threadId, { role: "user", kind: "text", text: raw, sendId: opts.sendId,
        replyToId: opts.replyTo?.id, sender: opts.sender, dataContext: opts.dataContext, queueId: opts.queueId }, undefined, enqueue);
    }
    store.titleTaskFromFirstMessage(botId, body.text, threadId);
    store.setTaskAskedAt(botId, threadId, message.at);
    store.patchTask(botId, threadId, { unread: false });
    return message;
  }

  function snapshot(sendId: string) {
    const history = store.messagesFor(threadId);
    const source = history.find(row => row.sendId === sendId && inbox.authorized(threadId, row));
    const job = source && inbox.get("direct-" + source.id);
    if (!source || !job) throw requestConflict("No acknowledged Dots request matches this sendId.");
    const messages = [source, ...history.filter(row => row.replyToId === source.id && row.dotsEventId)].map(slimMessage);
    const complete = job.stopped || Boolean(job.result && inbox.projectionOf(job.result.id));
    const result = { messageId: source.id, activeLeafId: store.activeLeaf(threadId), activeTurnId: null,
      executionId: job.turn.id, phase: complete ? "settled" : "waiting", messages };
    if (Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024) throw Object.assign(new Error("Open this Dots request in the workspace."), { status: 413 });
    return result;
  }

  function stop(id?: string) {
    const ids = id ? [id] : inbox.pendingDirectIds();
    if (ids.length > 1) throw requestConflict("Choose the Dots request to stop.");
    const job = ids[0] && inbox.get(ids[0]);
    if (!job || job.turn.parent || job.turn.threadId !== threadId) return false;
    const source = store.messagesFor(threadId).find(m => m.id === job.turn.sourceId);
    if (!inbox.authorized(threadId, source) || !host.stopWaiting(job.turn.id)) return false;
    if (job.turn.rootId !== job.turn.id) complete(job.turn.rootId, { kind: "failed", outcome: "stopped", text: "Stopped waiting for Dots." });
    store.patchMessage(threadId, job.turn.sourceId, { requestCancelled: true, requestPending: false });
    return true;
  }

  function restore(row: ChatFollowup) {
    const p = row.payload;
    if (!p.sendId || p.via || p.peerAsk || p.fromApp || p.unattended || !inbox.granted(threadId, p.sendId, p.text)) return;
    const history = store.messagesFor(threadId);
    const source = history.find(m => m.sendId === p.sendId && m.role === "user");
    if (source && (!inbox.authorized(threadId, source) || inbox.get("direct-" + source.id))) return;
    try {
      send(p.text, { ...p, replyTo: p.replyToId ? { id: p.replyToId } : undefined, queueId: row.id, userMessage: source });
    } catch (error) {
      if (!(error instanceof DotsInputError)) throw error;
      const dotsEventId = "host-queue-" + row.id;
      if (history.some(m => m.dotsEventId === dotsEventId)) return;
      const request = source ?? store.appendMessage(threadId, { role: "user", kind: "text", text: p.text, sendId: p.sendId,
        queueId: row.id, replyToId: p.replyToId, sender: p.sender });
      appendAtRequest(store, threadId, request.id, { role: "bot", kind: "text", dotsEventId, replyToId: request.id, text: error.message });
    }
  }

  function restoreQueued() {
    if (!legacy.length || !available()) return;
    const batch = legacy.slice(0, 16);
    for (const row of batch) restore(row);
    settleChatFollowups(batch.map(row => row.id), null);
    legacy.splice(0, batch.length);
  }

  return { send, snapshot, stop, restoreQueued, holdQueued(row: ChatFollowup) {
    if (row.kind !== "bot" || row.ownerId !== botId || row.threadId !== threadId || row.status === "cancelled") return false;
    legacy.push(row);
    return true;
  } };
}
