type ReceiptRow = { kind: string; tool?: { rescue?: { instanceId: string } } };

export function isDotsRescue(message: ReceiptRow): boolean {
  return message.kind === "activity" && message.tool?.rescue?.instanceId === "dots";
}

export function isReceipt(message: ReceiptRow): boolean {
  return message.kind === "digest" || message.kind === "compaction" || message.kind === "call" || isDotsRescue(message);
}

export function lastNonReceipt<T extends { kind: string }>(messages: readonly T[] | undefined): T | undefined {
  if (!messages) return undefined;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (!isReceipt(messages[i]!)) return messages[i];
  }
  return undefined;
}
