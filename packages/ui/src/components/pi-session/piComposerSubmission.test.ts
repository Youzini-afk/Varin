import { describe, expect, test } from 'vitest';
import type { MagicPromptId } from '@/lib/magicPrompts';
import { renderPiComposerSubmission } from './piComposerSubmission';

describe('Pi composer submission', () => {
  test('keeps native Pi and extension commands untouched', async () => {
    const rendered = await renderPiComposerSubmission('/skill:workspace-check');
    expect(rendered).toEqual({ text: '/skill:workspace-check' });
  });

  test('renders Varin magic commands into visible text and hidden instructions', async () => {
    const calls: Array<{ id: MagicPromptId; variables: Record<string, string> }> = [];
    const rendered = await renderPiComposerSubmission('/summary rate limits', async (id, variables = {}) => {
      calls.push({ id, variables });
      return id.endsWith('.visible') ? 'Visible summary request' : 'Hidden summary instructions';
    });

    expect(rendered).toEqual({
      instructions: 'Hidden summary instructions',
      text: 'Visible summary request',
    });
    expect(calls).toEqual([
      {
        id: 'session.summary.visible',
        variables: { topic_line: ' focused on: rate limits' },
      },
      {
        id: 'session.summary.instructions',
        variables: {
          topic_block: 'The user asked you to focus this summary on: rate limits. Prioritize that topic; mention unrelated threads only in passing.',
        },
      },
    ]);
  });
});
