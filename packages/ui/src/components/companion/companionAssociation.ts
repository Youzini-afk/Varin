import type { BotSummary } from '@varin/application-client';

/** Who the companion speaks for. It is an explicit Bot identity or the user's choice, never
 * inferred from the workbench shell, the focused Thread or the work being inspected. */
export type CompanionAssociation =
  | { route: 'bot-coordinator'; botId: string; name: string }
  | { route: 'agent-companion' | 'unknown'; botId: null; name?: never };

/** The stored user choice: a Bot id, or null for the Agent companion. Absent: no choice yet. */
export type CompanionChoice = { botId: string | null } | null;

export const COMPANION_CHOICE_KEY = 'varin.companion.association';

export function readCompanionChoice(raw: string | null): CompanionChoice {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === 'object' && 'botId' in value) {
      const botId = (value as { botId: unknown }).botId;
      if (botId === null || typeof botId === 'string' && botId.length > 0) return { botId };
    }
  } catch { /* An unreadable choice is no choice. */ }
  return null;
}

/** Usable Bots are those the Host still offers; the first one is the same default the Bot
 * workspace opens. A removed choice falls back like no choice; choosing no Bot is kept. */
export function companionAssociation(bots: readonly BotSummary[] | null, choice: CompanionChoice): CompanionAssociation {
  if (!bots) return { route: 'unknown', botId: null };
  if (choice?.botId === null) return { route: 'agent-companion', botId: null };
  const usable = bots.filter(bot => !bot.archived && !bot.deletion);
  const bot = (choice ? usable.find(value => value.id === choice.botId) : undefined) ?? usable[0];
  return bot ? { route: 'bot-coordinator', botId: bot.id, name: bot.name } : { route: 'agent-companion', botId: null };
}
