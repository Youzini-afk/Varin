import { describe, expect, test } from 'vitest';
import type { PiComposerAgentSelection } from './composerAgent';
import { renderPiComposerAgentInvocation } from './composerAgent';

const selection = (taskSeparator: 'double-dash' | 'space'): PiComposerAgentSelection => ({
  description: 'Gather context',
  id: 'scout',
  invocation: { command: 'run', kind: 'slash-command', taskSeparator },
  name: 'scout',
  providerId: 'pi-subagents',
});

describe('Pi composer agent invocation', () => {
  test('uses the provider-owned space invocation', () => {
    expect(renderPiComposerAgentInvocation('inspect the repository', selection('space')))
      .toBe('/run scout inspect the repository');
  });

  test('keeps hidden composer instructions inside the delegated task', () => {
    expect(renderPiComposerAgentInvocation('inspect', selection('double-dash'), 'Return evidence.'))
      .toBe('/run scout -- inspect\n\nReturn evidence.');
  });
});
