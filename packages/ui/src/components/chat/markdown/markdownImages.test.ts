import { afterEach, expect, test, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import morphdom from 'morphdom';
import { MarkdownBlockStream, renderMarkdownBlocks, renderMarkdownSync } from './markdownCore';
import { decorateMarkdownImages, MarkdownImageRegistry, preserveMarkdownImage } from './markdownImages';
import { groupMarkdownImageBlocks, resolveMarkdownImageSource } from './imageSources';

// This suite exercises parser/layout/ownership. Sanitization has its own boundary tests.
vi.mock('dompurify', () => ({ default: { isSupported: true, addHook() {}, sanitize: (html: string) => html } }));
const labels = { view: 'View', loading: 'Loading', retry: 'Retry', failed: 'Failed', long: 'Full image' };
afterEach(() => vi.unstubAllGlobals());
function root(html: string) {
  const { document, window } = parseHTML(`<html><body><main>${html}</main></body></html>`);
  vi.stubGlobal('HTMLElement', window.HTMLElement);
  vi.stubGlobal('Element', window.Element);
  const element = document.querySelector('main')!;
  decorateMarkdownImages(element, labels);
  return element;
}

test('keeps image groups beside their prose and retains ordinary inline image references', async () => {
  const markdown = 'Before\n\n![Old](C:/art/old.png)\n\n[New](C:/art/new.png)\n\nAfter [detail](https://example.test/detail.png).\n\n![Other](other.png)';
  const element = root(renderMarkdownSync(markdown));
  const groups = [...element.querySelectorAll('[data-md-image-gallery]')];
  expect(groups.map(group => group.querySelectorAll('[data-md-image-src]').length)).toEqual([2, 1]);
  expect(element.querySelector('[data-md-image-link]')?.textContent).toBe('detail');
  expect(element.querySelector('[data-md-image-src]')?.getAttribute('data-md-image-src')).toBe('C:/art/old.png');
  expect(element.querySelector('img')?.hasAttribute('src')).toBe(false);
  const blocks = await renderMarkdownBlocks(markdown, false, 'images-test', new MarkdownBlockStream());
  const withoutSourcePositions = (html: string) => html.replace(/ data-chat-source-(?:start|end)="[0-9]+"/g, '');
  expect(withoutSourcePositions(root(blocks.map(block => block.html).join('')).innerHTML)).toBe(withoutSourcePositions(element.innerHTML));
});

test('does not load a URL healed from incomplete streaming Markdown', async () => {
  const stream = new MarkdownBlockStream();
  const partial = await renderMarkdownBlocks('![Screen](https://example.test/screen.png', true, 'incomplete-test', stream);
  expect(partial.map(block => block.html).join('')).not.toContain('data-md-image-src');
  const complete = await renderMarkdownBlocks('![Screen](https://example.test/screen.png)', true, 'incomplete-test', stream);
  expect(complete.map(block => block.html).join('')).toContain('data-md-image-src="https://example.test/screen.png"');
});

test('groups adjacent images after the sanitizer serializes empty attributes', () => {
  const blocks = ['![First](a.png)', '![Second](b.png)', 'Explanation', '![Third](c.png)'].map((markdown, index) => ({
    id: String(index), html: renderMarkdownSync(markdown).replaceAll('data-md-image-gallery>', 'data-md-image-gallery="">'),
  }));
  const grouped = groupMarkdownImageBlocks(blocks);
  expect(grouped).toHaveLength(3);
  expect(root(grouped[0]!.html).querySelectorAll('[data-md-image-src]')).toHaveLength(2);
  expect(grouped[1]!.html).toContain('Explanation');
});

test('resolves image paths against their conversation and leaves unknown schemes inert', () => {
  expect(resolveMarkdownImageSource('figures/a%20b.png', 'D:/project')).toEqual({ kind: 'file', path: 'D:/project/figures/a b.png' });
  expect(resolveMarkdownImageSource('file:///C:/art/a%20b.png', '')).toEqual({ kind: 'file', path: 'C:/art/a b.png' });
  expect(resolveMarkdownImageSource('C:\\art\\a.png', '/other')).toEqual({ kind: 'file', path: 'C:/art/a.png' });
  expect(resolveMarkdownImageSource('relative.png', '')).toBeNull();
  expect(resolveMarkdownImageSource('javascript:alert(1)', '/project')).toBeNull();
});

test('loads near the viewport once, preserves decoded nodes through streaming and releases removed media', async () => {
  let intersect: IntersectionObserverCallback = () => {};
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: IntersectionObserverCallback) { intersect = callback; }
    observe() {} unobserve() {} disconnect() {}
  });
  const element = root(renderMarkdownSync('![Tall](tall.png)'));
  const release = vi.fn(), load = vi.fn(async () => ({ src: 'blob:preview', width: 200, height: 1000, release }));
  const open = vi.fn(), registry = new MarkdownImageRegistry(element, { labels, load, open, changed() {} });
  registry.refresh(); expect(load).not.toHaveBeenCalled();
  const node = element.querySelector<HTMLElement>('[data-md-image-src]')!;
  intersect([{ isIntersecting: true, target: node } as unknown as IntersectionObserverEntry], {} as IntersectionObserver);
  await vi.waitFor(() => expect(node.querySelector('img')?.getAttribute('src')).toBe('blob:preview'));
  node.querySelector('img')!.dispatchEvent(new element.ownerDocument.defaultView!.Event('load'));
  expect(node.dataset.imageShape).toBe('long');
  const next = root(renderMarkdownSync('![Tall](tall.png)\n\nMore text.'));
  morphdom(element, next, { childrenOnly: true, onBeforeElUpdated: (from, to) => !preserveMarkdownImage(from, to) });
  registry.refresh();
  expect(element.querySelector('[data-md-image-src]')).toBe(node);
  expect(node.querySelector('img')?.getAttribute('src')).toBe('blob:preview');
  expect(load).toHaveBeenCalledTimes(1);
  const recaptioned = root(renderMarkdownSync('![Changed caption](tall.png)'));
  morphdom(element, recaptioned, { childrenOnly: true, onBeforeElUpdated: (from, to) => !preserveMarkdownImage(from, to) });
  registry.refresh();
  intersect([{ isIntersecting: true, target: node } as unknown as IntersectionObserverEntry], {} as IntersectionObserver);
  await vi.waitFor(() => expect(node.querySelector('img')?.getAttribute('src')).toBe('blob:preview'));
  expect(load).toHaveBeenCalledTimes(1);
  node.remove(); registry.refresh(); await Promise.resolve(); expect(release).toHaveBeenCalledTimes(1);
  registry.cleanup(); expect(release).toHaveBeenCalledTimes(1);
});
