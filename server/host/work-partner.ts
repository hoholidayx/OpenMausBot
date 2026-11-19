import type { BotRecord, Message, Store } from "../store.ts";
import type { Coordinator, CoordinateBotsCall, HandoffView } from "../coordinator.ts";
import type { PartnerDelivery } from "../runtime/types.ts";
import { redactSecretsInText } from "../redact.ts";

type PartnerStore = Pick<Store, "bot" | "activePath" | "messagesFor" | "appendMessage" | "insertMessageAfter" | "taskByThread" | "patchTask">;

export function partnerBrief(bot: BotRecord, peers: readonly { id: string; name: string }[], automated: boolean, agentsMounted: boolean): string {
  if (automated || !agentsMounted) return "";
  const bound = peers.filter(peer => bot.workPartnerIds?.includes(peer.id));
  return bound.length ? "Your work partner: " + JSON.stringify(bound.map(({ id, name }) => ({ id, name }))) +
    ". Delegate suitable work using coordinate_bots. Your partner delivers its answer in this conversation." : "";
}

export function partnerSource(call: CoordinateBotsCall, bot: BotRecord, targets: string[], root: HandoffView | undefined,
  messageId?: string): string | undefined {
  if (!messageId || !root || root.parentId || root.groupId || root.origin?.kind !== "user" ||
    call.groupId || call.consult || call.answers || call.ownThread || call.post || !targets.every(id => bot.workPartnerIds?.includes(id))) return undefined;
  return messageId;
}

export function coordinationRouting(call: CoordinateBotsCall, external: boolean, partnerId?: string) {
  const mode = call.consult ? "consult" : !partnerId && call.reply === "none" ? "notify" : "work";
  const reply = mode === "notify" ? "none" : external ? "poll" : "resume";
  const returns = partnerId ? "your partner delivers its result directly here" : reply === "none" ? "nothing comes back from it" :
    reply === "poll" ? "read its result with assignment_status" : "its result will resume you";
  return { mode, reply, returns } as const;
}

export function partnerReceipt(receipts: readonly { requestId?: string; outcome: string }[], coordinator: Coordinator) {
  const accepted = receipts.filter(r => r.outcome !== "failed");
  return accepted.length > 0 && accepted.every(r => r.requestId && coordinator.node(r.requestId)?.partner);
}

export function appendAtRequest(store: Pick<Store, "activePath" | "messagesFor" | "appendMessage" | "insertMessageAfter">,
  threadId: string, origin: string, message: Omit<Message, "id" | "at">): boolean {
  if (store.activePath(threadId).some(row => row.id === origin)) {
    store.appendMessage(threadId, message);
    return true;
  }
  const history = store.messagesFor(threadId);
  if (!history.some(row => row.id === origin)) return false;
  const branch = new Set([origin]);
  let leaf = origin;
  for (const row of history) {
    if (!row.parentId || !branch.has(row.parentId)) continue;
    branch.add(row.id);
    leaf = row.id;
  }
  store.insertMessageAfter(threadId, leaf, message);
  return false;
}

export function committedPartnerRelay(store: Pick<Store, "messagesFor">, root: HandoffView): string | undefined {
  const receipt = store.messagesFor(root.threadId).find(row => row.turnTerminal &&
    row.partnerRelayReceipt?.rootId === root.id && row.partnerRelayReceipt.attempt === root.executions &&
    (row.text?.trim() || row.attachments?.length));
  return receipt ? receipt.text ?? "" : undefined;
}

export function finishPartnerRelay(store: PartnerStore, root: HandoffView, children: readonly HandoffView[], failureText: string,
  publish: (child: HandoffView, parent: HandoffView) => PartnerDelivery): boolean {
  if (root.status === "cancelled" || root.outcome === "stopped" || root.outcome === "refused") return false;
  const relays = children.filter(child => child.partner?.delivery === "relay");
  if (!relays.length || committedPartnerRelay(store, root) !== undefined) return false;
  const delivered = relays.filter(child => publish(child, root) === "direct");
  const origin = delivered[0]?.partner?.messageId;
  if (!origin || root.status !== "failed" || root.outcome !== "provider_error") return false;
  const duplicate = store.messagesFor(root.threadId).some(row => row.partnerRelayFailure?.rootId === root.id && row.partnerRelayFailure.attempt === root.executions);
  if (!duplicate) appendAtRequest(store, root.threadId, origin, { role: "bot", kind: "text", text: failureText,
    partnerRelayFailure: { rootId: root.id, attempt: root.executions } });
  return true;
}

function resultText(child: HandoffView, files: Pick<Message, "attachments">, empty: string) {
  const body = child.status === "completed" ? child.result : child.outcomeDetail || child.result;
  return redactSecretsInText(body) || (files.attachments?.length ? "" : empty);
}

export function deliverPartner(
  store: PartnerStore, child: HandoffView, parent: HandoffView, mayShare: boolean,
  attachments: Pick<Message, "attachments">, empty: string, contextChanged: (owner: BotRecord, threadId: string) => void,
  stage: "worker-finished" | "relay-fallback",
): PartnerDelivery {
  const origin = child.partner?.messageId;
  if (child.status === "cancelled" || child.outcome === "stopped") return "cancelled";
  if (!origin || !mayShare) return "unavailable";
  const owner = store.bot(parent.botId), author = store.bot(child.botId);
  if (!owner || !author || author.hidden) return "unavailable";
  const history = store.messagesFor(parent.threadId);
  if (!history.some(row => row.id === origin)) return "unavailable";
  if (history.some(row => row.partnerResultId === child.id)) return "direct";
  if (stage === "worker-finished" && child.status === "completed" && child.partner?.relay &&
    store.activePath(parent.threadId).some(row => row.id === origin)) return "relay";
  const row = { role: "bot", kind: "text", from: { botId: author.id, name: author.name, color: author.color },
    partnerResultId: child.id, partnerResultFailed: child.status === "failed" || undefined, replyToId: origin, text: resultText(child, attachments, empty), ...attachments,
    threadRef: { botId: child.botId, threadId: child.threadId, title: store.taskByThread(child.botId, child.threadId)?.title ?? author.name } } as const;
  if (appendAtRequest(store, parent.threadId, origin, row)) contextChanged(owner, parent.threadId);
  store.patchTask(parent.botId, parent.threadId, { unread: true });
  return "direct";
}
