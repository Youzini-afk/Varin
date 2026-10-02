import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { captureChatSelection, markdownSourceMap } from './chatSelection';

afterEach(() => vi.unstubAllGlobals());

describe('chat selection source mapping', () => {
  const sourceOf = (markdown: string, selected: string, occurrence = 0) => {
    vi.stubGlobal('document', parseHTML('<html><body></body></html>').document);
    const map = markdownSourceMap(markdown);
    let index = -1;
    for (let count = 0; count <= occurrence; count += 1) index = map.text.indexOf(selected, index + 1);
    expect(index).toBeGreaterThanOrEqual(0);
    return markdown.slice(map.starts[index], map.ends[index + selected.length - 1]);
  };
  it('preserves formatting and skips hidden link destinations when visible words repeat', () => {
    expect(sourceOf('Prefer **concise** answers.', 'Prefer concise answers.')).toBe('Prefer **concise** answers.');
    expect(sourceOf('[read](https://example.org/read) then read', 'read', 1)).toBe('read');
    expect(sourceOf('[read](https://example.org/read) then read', 'read then read')).toBe('read](https://example.org/read) then read');
  });
  it('maps escaped characters, Chinese text and entities without confusing code with HTML', () => {
    expect(sourceOf('记住：A &amp; B，使用 `x &amp; y`。', 'A & B')).toBe('A &amp; B');
    expect(sourceOf('使用 `x &amp; y`。', 'amp')).toBe('amp');
    expect(sourceOf('显示 \\*星号', '*星号')).toBe('*星号');
  });
  it('maps quoted paragraphs, lists, tables and fenced code back to original source', () => {
    expect(sourceOf('> 第一行\n> 第二行', '第一行\n第二行')).toBe('第一行\n> 第二行');
    expect(sourceOf('- **第一项**\n- 第二项', '第二项')).toBe('第二项');
    expect(sourceOf('| A | B |\n|---|---|\n| one | **two** |', 'two')).toBe('two');
    expect(sourceOf('```ts\nconst value = "&amp;";\n```', 'const value = "&amp;";')).toBe('const value = "&amp;";');
  });
  it('does not include text inside a closed tool disclosure in a selection spanning its neighbors', () => {
    const { document, window } = parseHTML('<html><body><p id="shown">Visible</p><details><summary>Tool</summary><p id="hidden">Hidden output</p></details></body></html>');
    vi.stubGlobal('document', document); vi.stubGlobal('Node', window.Node); vi.stubGlobal('NodeFilter', { SHOW_TEXT: 4 });
    const shown = document.getElementById('shown')!;
    const hidden = document.getElementById('hidden')!;
    const range = { intersectsNode: () => true, startContainer: shown.firstChild, startOffset: 0,
      endContainer: shown.firstChild, endOffset: 7, toString: () => 'VisibleToolHidden output' } as unknown as Range;
    const captured = captureChatSelection(range, new Map([
      [shown, { entryId: 'shown', text: 'Visible', offset: 12 }],
      [hidden, { entryId: 'hidden', text: 'Hidden output', offset: 0 }],
    ]), 'Visible');
    expect(captured).toEqual({ text: 'Visible', complete: true, passages: [{ entryId: 'shown', start: 12, text: 'Visible' }] });
  });
});
