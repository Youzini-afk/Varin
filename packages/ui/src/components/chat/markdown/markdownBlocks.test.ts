import { describe, expect, it } from 'vitest';
import { marked, type Tokens } from 'marked';
import { MarkdownBlockStream } from './markdownBlocks';

describe('incremental Markdown blocks', () => {
  it('keeps stable blocks and lexes only the mutable tail, including completion', () => {
    const inputs: string[] = [];
    const stream = new MarkdownBlockStream(text => { inputs.push(text); return marked.lexer(text) as Tokens.Generic[]; });
    const prefix = '# Title\n\nA completed paragraph.\n\n';
    const first = stream.read(prefix + 'Growing', true);
    const next = stream.read(prefix + 'Growing text', true);
    const final = stream.read(prefix + 'Growing text', false);
    expect(inputs.slice(1)).toEqual(['Growing text', 'Growing text']);
    expect(next[0]).toBe(first[0]);
    expect(next[1]).toBe(first[1]);
    expect(final[0]).toBe(next[0]);
    expect(final[1]).toBe(next[1]);
    expect(final.at(-1)?.src).toBe('Growing text');
  });

  it.each([
    'A heading\n---\n\nFollowing paragraph.',
    '| Name | Count |\n| --- | ---: |\n| one | 1 |\n\nEnd.',
    '- first\n\n  continued\n  - nested\n\n- second\n\nEnd.',
    '> quote\n>\n> second paragraph\n\nEnd.',
    'Intro\n\n```ts\nconst x = 1;\n```\n\nEnd.',
    'Intro\n\n```ts\nconst x = 1;',
    'Paragraph\r\n\r\n- first\r\n- second\r\n',
    '[reference][id]\n\nOther paragraph\n\n[id]:\n  https://example.test\n',
    '[reference][id]\n\n> [id]: https://example.test\n',
  ])('retains Markdown meaning across arbitrary chunk boundaries: %s', text => {
    const stream = new MarkdownBlockStream();
    for (let at = 1; at < text.length; at++) stream.read(text.slice(0, at), true);
    const final = stream.read(text, false);
    expect(final.map(block => marked.parse(block.src)).join('')).toBe(marked.parse(text));
  });

  it('invalidates on replacement and recognizes a reference definition arriving later', () => {
    const stream = new MarkdownBlockStream();
    stream.read('First\n\nTail', true);
    expect(stream.read('Replacement\n\nTail', false).map(block => block.src).join('')).toContain('Replacement');
    stream.read('[x][ref]\n\nOther\n\n[ref]:', true);
    const final = stream.read('[x][ref]\n\nOther\n\n[ref]:\n https://example.test', false);
    expect(final).toHaveLength(1);
    expect(marked.parse(final[0]!.src)).toContain('href="https://example.test"');
  });
});
