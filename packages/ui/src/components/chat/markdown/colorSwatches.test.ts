import { afterEach, expect, test, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { decorateColorSwatches } from './colorSwatches';

afterEach(() => vi.unstubAllGlobals());

test('decorates palette values in prose and inline code without changing text or duplicating swatches', () => {
  const { document } = parseHTML('<html><body><p>Use #cfbfb9 with <code>#161616</code>.</p><table><tbody><tr><td><code>#fff8</code></td><td>#aabbcc80</td></tr></tbody></table></body></html>');
  const before = document.body.textContent;
  decorateColorSwatches(document.body);
  expect([...document.querySelectorAll('[data-md-color]')].map(node => node.getAttribute('data-md-color')))
    .toEqual(['#cfbfb9', '#161616', '#fff8', '#aabbcc80']);
  expect(document.body.textContent).toBe(before);
  expect(document.querySelector('code')?.textContent).toBe('#161616');
  const decorated = document.body.innerHTML;
  decorateColorSwatches(document.body);
  expect(document.body.innerHTML).toBe(decorated);
});

test('leaves code fences, URLs, paths, math, invalid hex and color-like identifiers untouched', () => {
  const { document } = parseHTML('<html><body><pre><code>#abcdef</code></pre><a href="https://example.test/#123">#123</a><span class="katex">#123</span><p>path/#abc.png https://x/#fed #abcdefg #12345 #123456789 myrgb(1,2,3)</p><code>color: #fff; background: url(test)</code></body></html>');
  decorateColorSwatches(document.body);
  expect(document.querySelectorAll('[data-md-color]')).toHaveLength(0);
});

test('uses browser color validation for functional colors, writing only the color property', () => {
  const supports = vi.fn((_property: string, value: string) => ['rgb(12 30 40 / 50%)', 'oklch(70% 0.1 240)'].includes(value));
  vi.stubGlobal('CSS', { supports });
  const { document } = parseHTML('<html><body><p>rgb(12 30 40 / 50%) then rgb(invalid).</p><code>oklch(70% 0.1 240)</code></body></html>');
  decorateColorSwatches(document.body);
  const colors = [...document.querySelectorAll<HTMLElement>('[data-md-color]')];
  expect(colors.map(node => node.style.getPropertyValue('--md-color'))).toEqual(['rgb(12 30 40 / 50%)', 'oklch(70% 0.1 240)']);
  expect(supports).toHaveBeenCalledWith('color', 'rgb(invalid)');
});
