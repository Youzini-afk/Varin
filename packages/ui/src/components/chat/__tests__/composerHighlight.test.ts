import { expect, test } from 'vitest';
import { resolveHighlightSegments, tokenizeMarkdown, type HighlightRange } from '../composerHighlight';

const spans = (text: string) => tokenizeMarkdown(text).map(range => [text.slice(range.start, range.end), range.style]);

// Grammar examples live at the tokenizer boundary. Scanner helper return shapes,
// marker enumeration and CSS class spellings are not independent contracts.
test.each([
    ['# Title\n> quoted\n- item', [['#', 'marker'], ['Title', 'heading'], ['>', 'marker'], ['quoted', 'blockquote'], ['-', 'listMarker']]],
    ['run ``a ` b`` now', [['``a ` b``', 'code']]],
    ['[docs](https://example.test)', [['[', 'marker'], ['docs', 'link'], ['](', 'marker'], ['https://example.test', 'linkUrl'], [')', 'marker']]],
    ['***both***', [['***', 'marker'], ['both', 'strong'], ['both', 'emphasis'], ['***', 'marker']]],
    ['_slanted_ __bold__', [['_', 'marker'], ['slanted', 'emphasis'], ['_', 'marker'], ['__', 'marker'], ['bold', 'strong'], ['__', 'marker']]],
    ['!!! check `this`', [['!!!', 'marker'], ['check `this`', 'attention'], ['`this`', 'code']]],
])('highlights source text without hiding delimiters: %s', (text, expected) => {
    expect(spans(text as string)).toEqual(expected);
});

test.each([
    '', '##Title', '####### too deep', '-nodash', '2 * 3 * 4', 'foo_bar_baz',
    'trailing * ', '*never closed', '*open\nclose*', 'a ` b', '!!!important', 'that is wild!!!',
])('leaves prose and incomplete syntax alone: %s', text => expect(spans(text)).toEqual([]));

test.each(['```', '~~~'])('keeps fenced markdown literal until a matching close: %s', fence => {
    const text = `${fence}\n# not a heading\n- not a list\n${fence}\n# Heading`;
    expect(spans(text)).toEqual([
        [fence, 'codeFence'], ['# not a heading', 'codeFence'], ['- not a list', 'codeFence'],
        [fence, 'codeFence'], ['#', 'marker'], ['Heading', 'heading'],
    ]);
    expect(spans(`${fence}\n# still open`)).toEqual([[fence, 'codeFence'], ['# still open', 'codeFence']]);
});

test('a fence info string cannot close a block, but a longer matching fence can', () => {
    expect(spans('```\n```js\n# code\n````\n# heading')).toEqual([
        ['```', 'codeFence'], ['```js', 'codeFence'], ['# code', 'codeFence'], ['````', 'codeFence'],
        ['#', 'marker'], ['heading', 'heading'],
    ]);
});

test('preserves text and overlapping emphasis when resolving decorations', () => {
    const text = '# A **strong** title\nsee `code`';
    const ranges = tokenizeMarkdown(text);
    expect(ranges.some(range => range.style === 'heading')).toBe(true);
    expect(ranges.some(range => range.style === 'strong')).toBe(true);
    const segments = resolveHighlightSegments(text, ranges);
    expect(segments.map(segment => text.slice(segment.start, segment.end)).join('')).toBe(text);
    const strong = segments.find(segment => text.slice(segment.start, segment.end) === 'strong')!;
    const heading = resolveHighlightSegments('strong', [{ start: 0, end: 6, style: 'heading' }])[0]!;
    expect(strong.className).toContain(heading.className);
    expect(strong.className).not.toBe(heading.className);
});

test('resolves explicit priority without losing text around empty or overlapping ranges', () => {
    const first: HighlightRange = { start: 1, end: 4, style: 'code', className: 'first' };
    const ranges: HighlightRange[] = [first, { ...first, className: 'second', priority: 999 }, { start: 2, end: 2, style: 'code' }];
    const segments = resolveHighlightSegments('abcdef', ranges);
    expect(segments.map(segment => 'abcdef'.slice(segment.start, segment.end)).join('')).toBe('abcdef');
    expect(segments.find(segment => segment.start === 1)?.className).toBe('second');
    expect(resolveHighlightSegments('', ranges)).toEqual([]);
});
