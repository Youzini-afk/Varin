import { expect, test } from 'vitest';
import { resolveAutocompleteTrigger, type TriggerContext } from '../triggers';
const at = (marked: string, context: TriggerContext = { inputMode: 'normal' }) => resolveAutocompleteTrigger(marked.replace('|', ''), marked.indexOf('|'), context);
test.each([
  ['/rev|', 'command', 'rev', 0, 4], ['/|', 'command', '', 0, 1],
  [' /rev|', 'command', 'rev', 1, 5], ['/rev|iew now', 'command', 'rev', 0, 7],
  ['line\n/pl|', 'command', 'pl', 5, 8], ['/a b /c|', 'command', 'c', 5, 7],
  ['@|', 'mention', '', 0, 1],
])('resolves only the explicit fragment: %s', (text, kind, query, from, to) => expect(at(text)).toEqual({ kind, query, from, to }));
test.each(['/review |', '/review\nnext line|', 'src/comp|', 'run /explore |', 'me@example|', '@scope/package|', 'npm install @scope/package|', '@build now|', 'https://example.com/@a|', '`/tree|`', '```sh\n/compact|\n```', '~~~\n@file|\n~~~', 'plain prose|', '|'])('keeps prose and literals inert: %s', text => expect(at(text)).toBeNull());
test('pasted text does not start a picker, but keywords in an open query do', () => {
  expect(at('/compact|', { inputMode: 'normal', inputSource: 'paste', insertedText: '/compact' })).toBeNull();
  expect(at('@src/app.ts|', { inputMode: 'normal', inputSource: 'paste', insertedText: '@src/app.ts' })).toBeNull();
  expect(at('@my file|', { inputMode: 'normal', inputSource: 'paste', insertedText: 'my file', active: { kind: 'mention', query: '', from: 0, to: 1 } }))
    .toEqual({ kind: 'mention', query: 'my file', from: 0, to: 8 });
});
test('a slash inside an open file query does not change the picker or insertion range', () => {
  expect(at('see @my folder/file|', { inputMode: 'normal', active: { kind: 'mention', query: 'my folder', from: 4, to: 14 } }))
    .toEqual({ kind: 'mention', query: 'my folder/file', from: 4, to: 19 });
});
test.each(['/rev|', '@src|', 'run /review|'])('shell mode disables autocomplete: %s', text => expect(at(text, { inputMode: 'shell' })).toBeNull());
