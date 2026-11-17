// A Team Cloud member's own MausBot: its main chat is that person's, the way a chat they open is. Security: so it is
// private to them, an admin included.
import { defaultBotPerson, type DefaultBotFields } from "../../shared/default-bot.ts";

export interface MausBotOwnChatDeps {
  bots(): ReadonlyArray<{ id: string; threadId: string } & DefaultBotFields>;
  starters: { get(threadId: string): string | undefined; set(threadId: string, person: string): void };
  personKey(email: string): string;
}

export function createMausBotOwnChat(deps: MausBotOwnChatDeps) {
  const claim = (bot: { id: string; threadId: string } & DefaultBotFields): boolean => {
    const email = defaultBotPerson(bot);
    if (!email || deps.starters.get(bot.threadId) !== undefined) return false;
    const person = deps.personKey(email);
    deps.starters.set(bot.threadId, person);
    return true;
  };
  return {
    claim,
    /** At start, for the MausBots made before their main chat was their person's. */
    claimAll(): number {
      return deps.bots().filter(claim).length;
    },
  };
}
