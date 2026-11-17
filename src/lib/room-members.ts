import type { AppState, Bot } from "@/state/store";

export function canJoinRoom(bot: Pick<Bot, "modelSelection">, instances: AppState["instances"]): boolean {
  return instances.some(instance => instance.instanceId === bot.modelSelection.instanceId && instance.capabilities?.roomChat === true);
}

export function nextMemberIds(current: string[], picked: Set<string>, order: string[]): string[] {
  return [...current.filter((id) => picked.has(id)), ...order.filter((id) => picked.has(id) && !current.includes(id))];
}
