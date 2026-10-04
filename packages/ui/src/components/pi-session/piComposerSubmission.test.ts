import { describe, expect, test } from 'vitest';
import type { MagicPromptId } from '@/lib/magicPrompts';
import { renderPiComposerSubmission } from './piComposerSubmission';

describe('Pi composer submission', () => {
  test('keeps native Pi and extension commands untouched', async () => {
    const rendered = await renderPiComposerSubmission('/skill:workspace-check');
    expect(rendered).toEqual({ text: '/skill:workspace-check' });
  });

  test('passes a summary topic to both prompt templates', async () => {
    const topic = 'rate limits';
    const calls: Array<{ id: MagicPromptId; variables: Record<string, string> }> = [];
    const rendered = await renderPiComposerSubmission(`/summary ${topic}`, async (id, variables = {}) => {
      calls.push({ id, variables });
      return id.endsWith('.visible') ? 'Visible summary request' : 'Summary instructions';
    });

    expect(rendered).toEqual({
      instructions: 'Summary instructions',
      text: 'Visible summary request',
    });
    expect(calls.map(({ id }) => id)).toEqual([
      'session.summary.visible',
      'session.summary.instructions',
    ]);
    expect(calls[0].variables.topic_line).toContain(topic);
    expect(calls[1].variables.topic_block).toContain(topic);
  });

  test.each([
    'workspace-review',
    'plan-feature',
    'catch-up',
    'debug',
    'weigh',
    'explore',
  ])('preserves the full user input after /%s even without template slots', async (command) => {
    const argument = 'Focus on src/队列.ts\nKeep `$1`, {{values}}, and /native-command unchanged.';
    const visible = 'The selected prompt template';
    const instructions = 'The selected instruction template';
    const rendered = await renderPiComposerSubmission(`/${command} ${argument}`, async (id) => (
      id.endsWith('.visible') ? visible : instructions
    ));

    expect(rendered).toEqual({
      instructions,
      text: `${visible}\n\n${argument}`,
    });
  });

  test('does not append an empty argument block', async () => {
    const rendered = await renderPiComposerSubmission('/debug   ', async (id) => (
      id.endsWith('.visible') ? 'Debug the issue' : 'Issue context'
    ));

    expect(rendered).toEqual({ text: 'Debug the issue', instructions: 'Issue context' });
  });
});
