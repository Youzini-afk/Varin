import { describe, expect, test } from 'vitest';
import { resolveHighlightSegments } from '../../../composerHighlight';
import { tokenizeComposer, tokenizeMentions, type ComposerLanguageContext } from '../tokenize';

const context: ComposerLanguageContext = {
    inputMode: 'normal',
    knownAgentNames: new Set(['build', 'plan', 'a.ts']),
    confirmedMentions: new Set(['NOTES']),
    knownSlashNames: new Set(['review', 'skill:workspace-check']),
    attachmentFilenames: ['shot.png'],
};
const styled = (text: string) => tokenizeComposer(text, context)
    .filter(range => ['mentionAgent', 'mentionFile', 'mentionCommand', 'path'].includes(range.style))
    .map(range => [text.slice(range.start, range.end), range.style]);

describe('composer references', () => {
    // Test the consumer boundary once, not each scanner and its mapping helper again.
    test.each([
        ['ask @Build and (@plan)', [['@Build', 'mentionAgent'], ['@plan', 'mentionAgent']]],
        ['see `@src/app.ts`, @NOTES and @src/components/', [['@src/app.ts', 'mentionFile'], ['@NOTES', 'mentionFile'], ['@src/components/', 'mentionFile']]],
        ['@a.ts', [['@a.ts', 'mentionAgent']]], // Registered agents outrank file-looking names.
        ['run /Review then /skill:workspace-check', [['/Review', 'mentionCommand'], ['/skill:workspace-check', 'mentionCommand']]],
        ['see [shot.png] and [missing.png]', [['[shot.png]', 'mentionFile']]],
        ['(~src/app.ts), ~README.md ~C:\\repo\\a.ts', [['~src/app.ts', 'path'], ['~README.md', 'path'], ['~C:\\repo\\a.ts', 'path']]],
    ])('%s', (text, expected) => expect(styled(text as string)).toEqual(expected));

    test.each([
        'me@example.com foo@scope/pkg @stranger @... @',
        '@import</style> @src/<style.css',
        'src/app.ts /unknown / /-dash /_under #sig',
        '~approximately ~500 ~1.2 ~0.5x foo~bar/baz.ts ~~struck~~',
        '~~~\nbody\n~~~',
        '',
    ])('leaves non-references as ordinary text: %s', text => expect(styled(text)).toEqual([]));

    test('only explicit references become attachments; inert paths and unknown words do not', () => {
        const text = 'see @Build, @src/a.ts and @NOTES; ~src/b.ts @nobody';
        expect(tokenizeMentions(text, context).map(range => [text.slice(range.start, range.end), range.kind]))
            .toEqual([['@Build', 'agent'], ['@src/a.ts', 'file'], ['@NOTES', 'file']]);
    });

    test('combines markdown and references without changing the text or swallowing punctuation', () => {
        const text = '# Title\nsee `@src/app.ts`, **bold** and /review';
        const ranges = tokenizeComposer(text, context);
        expect(new Set(ranges.map(range => range.style)))
            .toEqual(new Set(['marker', 'heading', 'code', 'strong', 'mentionFile', 'mentionCommand']));
        const segments = resolveHighlightSegments(text, ranges);
        expect(segments.map(segment => text.slice(segment.start, segment.end)).join('')).toBe(text);
        expect(segments.map(segment => text.slice(segment.start, segment.end))).toContain('@src/app.ts');
    });

    test('shell input bypasses the entire prompt language', () => {
        expect(tokenizeComposer('# Title\n@build /review ~src/a.ts [shot.png] **bold**', { ...context, inputMode: 'shell' })).toEqual([]);
    });
});
