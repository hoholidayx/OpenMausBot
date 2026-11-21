import { randomUUID } from "node:crypto";
import type { Store, BotRecord, Message } from "../store.ts";
import { appendAtRequest } from "../host/work-partner.ts";
import { DOTS_SELECTION } from "./driver.ts";
import { directDotsMessages } from "./direct.ts";
import type { DotsReceipt } from "./client.ts";
import { dotsText, type DotsHost, type DotsProjection } from "./host.ts";
import type { DotsJob, DotsTurn } from "./inbox.ts";

export function connectDots(host: DotsHost, store: Store, privateHome: () => boolean, complete: DotsProjection["complete"],
  workAvailable: (turn: DotsTurn) => boolean | undefined) {
  const { inbox } = host;
  const { botId, threadId: inboxThread } = inbox;
  if (privateHome() && !inbox.installed) {
    if (!store.bot(botId)) store.createBot({ name: "Dots", title: "工作端", visibility: "admins", modelSelection: DOTS_SELECTION },
      { id: botId, threadId: inboxThread, seedMessages: false });
    inbox.markInstalled();
  }
  const privateThread = (id: string, thread: string) => {
    const bot = store.bot(id), task = store.taskByThread(id, thread);
    return privateHome() && !!bot && !bot.hidden && bot.visibility === "admins" && !!task && !task.archivedAt && !store.groupByThread(thread);
  };
  const available = () => store.bot(botId)?.modelSelection.instanceId === "dots" && privateThread(botId, inboxThread);
  const direct = directDotsMessages(host, store, available, complete);
  const line = (thread: string, id: string) => store.messagesFor(thread).find(m => m.id === id);
  const eligible = (bot: BotRecord, thread: string) => available() && bot.id !== botId && privateThread(bot.id, thread);
  const bound = (bot: BotRecord, thread: string) => eligible(bot, thread) && bot.workPartnerIds?.[0] === botId && bot.workPartnerThreadId === thread;
  const authorized = (thread: string, id: string) => inbox.authorized(thread, line(thread, id));
  const permitted = (turn: DotsTurn, receiptId?: string) => {
    if (!available() || !privateThread(botId, turn.threadId) || !line(turn.threadId, turn.sourceId)) return false;
    const p = turn.parent;
    if (!p) return turn.threadId === inboxThread && authorized(inboxThread, turn.sourceId);
    if (!privateThread(p.botId, p.threadId) || !authorized(p.threadId, p.messageId)) return false;
    // After assignment retention expires, only a receipt previously delivered to its authorized thread can expose a file.
    return workAvailable(turn) ?? (receiptId !== undefined && inbox.projectionOf(receiptId) === 1);
  };

  function original(receipt: DotsReceipt, job: DotsJob | null) {
    if (receipt.kind === "push") return available() && !receipt.correlation_id && !receipt.message_id && !receipt.request_id ? inboxThread : undefined;
    return job && permitted(job.turn, receipt.id) && !(job.stopped && job.turn.parent) ? job.turn.threadId : undefined;
  }
  function terminalRequest(receipt: DotsReceipt, job: DotsJob | null) {
    if (!job || job.turn.parent || receipt.id !== job.result?.id) return {};
    const { id, sourceId, threadId } = job.turn;
    if (line(threadId, sourceId)?.requestPending) store.patchMessage(threadId, sourceId, { requestPending: false });
    return { turnId: id, turnTerminal: true, requestMessageId: sourceId, turnSucceeded: receipt.kind === "reply" };
  }
  function updateFiles(fileId: string) {
    for (const { receipt, op } of inbox.references(fileId)) {
      const job = op ? inbox.get(op) : null, thread = original(receipt, job);
      if (!thread) continue;
      const dotsFiles = inbox.files(receipt);
      const row = store.messagesFor(thread).find(m => m.dotsEventId === receipt.id);
      if (row) store.patchMessage(thread, row.id, { dotsFiles });
      const parent = job?.turn.parent;
      if (parent && job?.result?.id === receipt.id) {
        const result = store.messagesFor(parent.threadId).find(m => m.partnerResultId === op);
        if (result) store.patchMessage(parent.threadId, result.id, { dotsFiles });
      }
    }
  }
  function project(receipt: DotsReceipt, job: DotsJob | null) {
    if (receipt.kind.startsWith("attachment_") && receipt.artifact_id) { updateFiles(receipt.artifact_id); return true; }
    const thread = original(receipt, job);
    if (!thread) return false;
    if (receipt.kind === "progress" && job?.result && job.result.sequence < receipt.sequence) return false;
    if (receipt.kind !== "push" && receipt.kind !== "progress" && receipt.id !== job?.result?.id) return false;
    const terminal = terminalRequest(receipt, job);
    if (store.messagesFor(thread).some(m => m.dotsEventId === receipt.id)) return true;
    const dotsFiles = inbox.files(receipt);
    const row: Omit<Message, "id" | "at"> = { role: "bot", kind: "text", dotsEventId: receipt.id, text: dotsText(receipt),
      ...(dotsFiles.length ? { dotsFiles } : {}), ...(job ? { replyToId: job.turn.sourceId } : {}),
      ...terminal };
    if (receipt.kind === "progress" && job?.turn.parent) {
      row.kind = "activity"; row.tool = { name: receipt.text || "Dots", ok: true };
    }
    if (job) appendAtRequest(store, thread, job.turn.sourceId, row);
    else store.appendMessage(thread, row);
    store.patchTask(botId, thread, { unread: true });
    return true;
  }
  return {
    botId, inboxThread, available, eligible, bound, authorized, permitted, project, complete, direct, restoreQueued: direct.restoreQueued,
    workThread: (thread: string) => privateThread(botId, thread),
    canBind(bot: BotRecord, thread: string) {
      return eligible(bot, thread) && !store.bots.some(b => b.workPartnerIds?.includes(botId) && (b.id !== bot.id || b.workPartnerThreadId !== thread));
    },
    grant(bot: BotRecord, thread: string, text: string, send?: string) {
      if (!(bot.id === botId && thread === inboxThread && available()) && !bound(bot, thread)) return send;
      const key = send ?? randomUUID();
      inbox.authorize(thread, key, text);
      return key;
    },
    file(thread: string, messageId: string, id: string) {
      const row = line(thread, messageId);
      if (!row?.dotsFiles?.some(f => f.id === id)) return;
      for (const { receipt, op } of inbox.references(id)) {
        const job = op ? inbox.get(op) : null, source = original(receipt, job);
        if (!source) continue;
        const own = row.dotsEventId === receipt.id && source === thread;
        const parent = job?.turn.parent;
        if (own || (parent?.threadId === thread && row.partnerResultId === op && job?.result?.id === receipt.id)) return inbox.files(receipt).find(f => f.id === id);
      }
    },
  };
}
