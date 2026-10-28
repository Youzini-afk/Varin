import { expect, test } from 'vitest';
import { resolveAutocompleteTrigger, type TriggerContext } from '../triggers';

const at = (marked: string, context: TriggerContext = { inputMode: 'normal' }) =>
    resolveAutocompleteTrigger(marked.replace('|', ''), marked.indexOf('|'), context);

test.each([
    ['/rev|', 'command', 'rev'], ['/|', 'command', ''],
    [' /rev|', 'skill', 'rev'], ['/rev|iew now', 'skill', 'rev'], ['line\n/pl|', 'skill', 'pl'], ['/a b /c|', 'skill', 'c'],
    ['see @src/ap|', 'mention', 'src/ap'], ['@|', 'mention', ''],
])('opens the picker at the caret: %s', (text, kind, query) => {
    expect(at(text)).toEqual({ kind, query });
});

test.each([
    '/review |', '/review\nnext line|', 'src/comp|', 'run /explore |',
    'me@example|', '@build now|', 'plain prose|', '#sig|', '|',
])('does not interrupt completed tokens or prose: %s', text => expect(at(text)).toBeNull());

test('pasting an entire reference does not open a picker, but pasting into one keeps it usable', () => {
    expect(at('@src/app.ts|', { inputMode: 'normal', inputSource: 'paste', insertedText: '@src/app.ts' })).toBeNull();
    expect(at('@src|', { inputMode: 'normal', inputSource: 'paste', insertedText: 'src' }))
        .toEqual({ kind: 'mention', query: 'src' });
});

test.each(['/rev|', '@src|', 'run /review|'])('shell mode disables autocomplete: %s', text => {
    expect(at(text, { inputMode: 'shell' })).toBeNull();
});
