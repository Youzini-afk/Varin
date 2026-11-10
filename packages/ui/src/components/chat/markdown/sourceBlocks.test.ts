import { afterEach, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { MarkdownBlockStream, renderMarkdownBlocks, renderMarkdownSync } from './markdownCore';
import { bindRenderedMarkdownSource } from './sourceBlocks';
import { captureChatSourceBlock, findChatSourceElement } from '@/components/conversation/chatSelection';
vi.mock('dompurify', () => ({ default: { isSupported: true, addHook() {}, sanitize: (html: string) => html } }));
vi.mock('./markdown-worker', () => ({ highlightCodeInWorker: async () => null }));
afterEach(() => vi.unstubAllGlobals());
function rendered(text: string, html = renderMarkdownSync(text), offset = 0) {
  const { document, window } = parseHTML(`<html><body><article data-conversation-source-id="entry" data-conversation-source-offset="${offset}"><div>${html}</div></article></body></html>`);
  vi.stubGlobal('document', document); vi.stubGlobal('Node', window.Node);
  const root = document.querySelector('article')!, block = root.firstElementChild!;
  bindRenderedMarkdownSource(block, text);
  const sources = new Map([[root, { entryId: 'entry', text, offset, role: 'assistant' }]]);
  return { root, block, capture: (selector: string) => captureChatSourceBlock(root.querySelector(selector)!, sources) };
}
it('captures renderer-owned paragraph, nested list body, code language and table source, not nearby DOM labels', () => {
  const raw = '# Title\n\n[Same](https://example.test) **paragraph**\n\n- parent\n  continued\n  - child\n- sibling\n\n```ts\nconst x = 1;\n```\n\n| A | B |\n| - | - |\n| 1 | 2 |';
  const view = rendered(raw, undefined, 20);
  expect(view.capture('a')?.text).toBe('[Same](https://example.test) **paragraph**');
  expect(view.capture('li')?.text).toBe('- parent\n  continued');
  expect(view.capture('li li')?.text).toBe('- child');
  expect(view.capture('code')?.text).toBe('```ts\nconst x = 1;\n```');
  expect(view.capture('td')?.text).toBe('| A | B |\n| - | - |\n| 1 | 2 |');
  const quote = view.capture('a')!;
  expect(quote.passages[0]?.start).toBe(20 + raw.indexOf('[Same]'));
  expect(findChatSourceElement(view.root.parentElement!, 'entry', quote.passages[0]!.start)?.tagName).toBe('P');
});
it('captures only the painted streaming generation and holds it after nodes detach', async () => {
  const raw = 'First\n\nGrowing';
  const blocks = await renderMarkdownBlocks(raw, true, 'freeze-capture', new MarkdownBlockStream());
  const view = rendered(raw, blocks.map(block => `<section>${block.html}</section>`).join(''));
  [...view.block.children].forEach((element, index) => bindRenderedMarkdownSource(element, raw, 0, blocks[index]!.offset));
  const frozen = view.capture('section:last-child p')!;
  view.root.remove();
  expect(frozen.text).toBe('Growing');
  expect(frozen.passages).toEqual([{ entryId: 'entry', start: 7, text: 'Growing' }]);
});
it('maps repeated source text in distinct quoted paragraphs rather than the first textContent match', () => {
  const raw = '> repeat\n>\n> repeat\n\nrepeat';
  const view = rendered(raw);
  expect(view.capture('blockquote p:nth-child(2)')?.passages).toEqual([{ entryId: 'entry', start: raw.indexOf('repeat', raw.indexOf('repeat') + 1), text: 'repeat' }]);
  expect(view.capture('article > div > p')?.passages[0]?.start).toBe(raw.lastIndexOf('repeat'));
});

it('retains CRLF source positions across block streaming and interactive prose segments', async () => {
  const raw = 'First\r\n\r\nSecond\r\nline';
  const blocks = await renderMarkdownBlocks(raw, false, 'crlf-capture', new MarkdownBlockStream());
  const view = rendered(raw, blocks.map(block => `<section>${block.html}</section>`).join(''));
  [...view.block.children].forEach((element, index) => bindRenderedMarkdownSource(element, raw, 0, blocks[index]!.offset));
  expect(view.capture('section:last-child p')?.passages).toEqual([{ entryId: 'entry', start: 9, text: 'Second\r\nline' }]);
});
