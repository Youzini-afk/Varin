import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MarkdownInk } from './markdownInk';

let document: Document;
let target: HTMLElement;

beforeEach(() => {
  ({ document } = parseHTML('<html><body><div id="md"></div></body></html>'));
  target = document.getElementById('md')!;
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

const render = (html: string, ink: MarkdownInk, revealing = true) => {
  ink.prepare();
  target.innerHTML = html;
  ink.update(target, revealing, 'full');
};

const inked = () => [...target.querySelectorAll('.markdown-ink')].map(span => span.textContent).join('|');

it('inks only the text revealed since the last render and keeps the dot at the end', () => {
  const ink = new MarkdownInk();
  render('<p>Hello</p>', ink);
  expect(inked()).toBe('Hello');
  vi.advanceTimersByTime(50);
  render('<p>Hello <strong>wor</strong></p>', ink);
  expect(target.textContent).toBe('Hello wor');
  // Two runs still developing, split at element boundaries, in document order.
  expect(inked()).toBe('Hello| |wor');
  const caret = target.querySelector('.markdown-caret')!;
  expect(caret.previousSibling?.textContent).toBe('wor');
  expect(caret.getAttribute('aria-hidden')).toBe('true');
});

it('resumes each span at its age and merges old ink back into text', () => {
  const ink = new MarkdownInk();
  render('<p>One</p>', ink);
  vi.advanceTimersByTime(120);
  render('<p>One two</p>', ink);
  const delays = [...target.querySelectorAll<HTMLElement>('.markdown-ink')].map(span => span.style.animationDelay);
  expect(delays.some(delay => delay === '-120ms' || delay === '-0ms' || delay === '0ms')).toBe(true);
  vi.advanceTimersByTime(500);
  expect(target.querySelector('.markdown-ink')).toBeNull();
  expect(target.querySelector('p')!.childNodes[0]!.textContent).toBe('One two');
});

it('starts a joined stream without replaying its text', () => {
  const ink = new MarkdownInk();
  render(`<p>${'x'.repeat(200)}</p>`, ink);
  expect(inked()).toBe('');
  render(`<p>${'x'.repeat(205)}</p>`, ink);
  expect(inked()).toBe('xxxxx');
});

it('lets the dot breathe while waiting and shrink away at the end', () => {
  const ink = new MarkdownInk();
  render('<p>Text</p>', ink);
  const caret = target.querySelector<HTMLElement>('.markdown-caret')!;
  expect(caret.dataset.state).toBe('writing');
  vi.advanceTimersByTime(300);
  expect(caret.dataset.state).toBe('waiting');
  render('<p>Text done</p>', ink, false);
  expect(target.querySelector<HTMLElement>('.markdown-caret')!.dataset.state).toBe('leaving');
  vi.advanceTimersByTime(200);
  expect(target.querySelector('.markdown-caret')).toBeNull();
});

it('leaves no nodes behind when motion is off or the ink is cleared', () => {
  const ink = new MarkdownInk();
  render('<p>Text</p>', ink);
  ink.prepare();
  target.innerHTML = '<p>Text more</p>';
  ink.update(target, true, 'off');
  expect(target.innerHTML).toBe('<p>Text more</p>');
  render('<p>Text more again</p>', ink);
  ink.clear();
  expect(target.querySelector('.markdown-ink, .markdown-caret')).toBeNull();
  expect(target.textContent).toBe('Text more again');
});

it('never inks text inside rendered math or controls', () => {
  const ink = new MarkdownInk();
  render('<p>a <span class="katex">x²</span> <button>Copy</button></p>', ink);
  expect(inked()).not.toContain('x²');
  expect(inked()).not.toContain('Copy');
});
