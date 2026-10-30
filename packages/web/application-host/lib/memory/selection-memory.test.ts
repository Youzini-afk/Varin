import { expect, it } from 'vitest';
import { parseSelectionMemories } from './selection-memory.js';

const passages = [
  { role: 'user', passage: { start: 4, text: 'Blue accents are good, but do not tint the whole interface.', revision: 'one' } },
  { role: 'assistant', passage: { start: 0, text: 'The earlier theme changed the whole background.', revision: 'two' } },
];

it('keeps a connected account with several exact sources and no required classification', () => {
  const [memory] = parseSelectionMemories(JSON.stringify({ memories: [{
    content: 'The user likes blue accents and objected when the earlier theme tinted the background.',
    sources: [{ source: 's0', quote: 'Blue accents are good' }, { source: 's1', quote: 'changed the whole background' }],
  }] }), passages);
  expect(memory).toMatchObject({ trigger: '', sources: [
    { start: 4, text: 'Blue accents are good', revision: 'one' },
    { start: passages[1]!.passage.text.indexOf('changed'), text: 'changed the whole background', revision: 'two' },
  ] });
  expect(memory).not.toHaveProperty('nature');
});

it('rejects an unsupported citation and assistant-only instruction attribution', () => {
  for (const memory of [
    { content: 'Unsupported', sources: [{ source: 's1', quote: 'Never wrote this' }] },
    { content: 'Instruction', nature: 'instruction', sources: [{ source: 's1', quote: 'earlier theme' }] },
  ]) expect(() => parseSelectionMemories(JSON.stringify({ memories: [memory] }), passages)).toThrow();
});
