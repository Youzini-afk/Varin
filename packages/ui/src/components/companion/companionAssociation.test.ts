import { expect, it } from 'vitest';
import type { BotSummary } from '@varin/application-client';
import { companionAssociation, readCompanionChoice } from './companionAssociation';

const bot = (id: string, patch: Partial<BotSummary> = {}) => ({ id, name: `Bot ${id}`, archived: false, ...patch }) as BotSummary;

it('speaks for the chosen Bot, the default Bot, or explicitly no Bot', () => {
  const bots = [bot('a'), bot('b')];
  expect(companionAssociation(bots, null)).toEqual({ route: 'bot-coordinator', botId: 'a', name: 'Bot a' });
  expect(companionAssociation(bots, { botId: 'b' })).toMatchObject({ route: 'bot-coordinator', botId: 'b' });
  expect(companionAssociation(bots, { botId: null })).toEqual({ route: 'agent-companion', botId: null });
  // A removed or archived choice falls back to the default; the Agent choice is kept.
  expect(companionAssociation([bot('a'), bot('b', { archived: true })], { botId: 'b' })).toMatchObject({ botId: 'a' });
  expect(companionAssociation([bot('a', { deletion: { operationId: 'x', error: null } })], null)).toEqual({ route: 'agent-companion', botId: null });
  expect(companionAssociation([], { botId: 'gone' })).toEqual({ route: 'agent-companion', botId: null });
});

it('stays unknown until the Host catalog is read and ignores malformed stored choices', () => {
  expect(companionAssociation(null, { botId: 'a' })).toEqual({ route: 'unknown', botId: null });
  expect(readCompanionChoice(null)).toBeNull();
  expect(readCompanionChoice('{"botId":null}')).toEqual({ botId: null });
  expect(readCompanionChoice('{"botId":"a"}')).toEqual({ botId: 'a' });
  for (const raw of ['', 'nope', '{"botId":""}', '{"botId":3}', '[]']) expect(readCompanionChoice(raw)).toBeNull();
});
