import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const highlightLinesInWorker = vi.fn(async (code: string, _lang: string) => code.split('\n').map(line => `<span style="color:red">${line}</span>`));
vi.mock('./markdown-worker', () => ({ highlightLinesInWorker: (code: string, lang: string) => highlightLinesInWorker(code, lang) }));

const { LIVE_FENCE_HIGHLIGHT_DELAY_MS, liveFenceLines, parseOpenFence, renderOpenFence, resetLiveFences, subscribeLiveFence } = await import('./liveFence');

beforeEach(() => { vi.useFakeTimers(); highlightLinesInWorker.mockClear(); });
afterEach(() => { resetLiveFences(); vi.useRealTimers(); });

const settle = async () => {
  await vi.advanceTimersByTimeAsync(LIVE_FENCE_HIGHLIGHT_DELAY_MS + 1);
};

it('splits an open fence into completed lines and the line being written', () => {
  expect(parseOpenFence('```TS')).toBeNull();
  expect(parseOpenFence('```TS\nconst a = 1;\nconst b')).toEqual({ lang: 'ts', completed: 'const a = 1;', partial: 'const b' });
  expect(parseOpenFence('```\nx\n')).toEqual({ lang: 'text', completed: 'x', partial: '' });
});

it('colours completed lines after they settle and keeps the line being written plain', async () => {
  const owner = vi.fn();
  const unsubscribe = subscribeLiveFence(owner);
  const fence = parseOpenFence('```ts\nconst a = 1;\nconst b = 2;\nconst c')!;
  expect(liveFenceLines('m:0', 'm', fence)).toEqual([]);
  await settle();
  expect(highlightLinesInWorker).toHaveBeenCalledTimes(1);
  expect(owner).toHaveBeenCalledWith('m');
  const coloured = liveFenceLines('m:0', 'm', fence);
  expect(coloured).toHaveLength(2);
  const html = renderOpenFence(fence, coloured);
  expect(html).toBe('<pre><code class="language-ts"><span class="line"><span style="color:red">const a = 1;</span></span>\n'
    + '<span class="line"><span style="color:red">const b = 2;</span></span>\n<span class="line">const c</span></code></pre>');
  unsubscribe();
});

it('reuses the newest result that is still a prefix and asks once per change', async () => {
  liveFenceLines('m:0', 'm', parseOpenFence('```ts\na\nb')!);
  await settle();
  // More lines completed: the earlier result still colours its lines meanwhile.
  const grown = parseOpenFence('```ts\na\nb\nc\nd')!;
  expect(liveFenceLines('m:0', 'm', grown)).toHaveLength(1);
  liveFenceLines('m:0', 'm', grown);
  liveFenceLines('m:0', 'm', grown);
  await settle();
  expect(highlightLinesInWorker).toHaveBeenCalledTimes(2);
  expect(liveFenceLines('m:0', 'm', grown)).toHaveLength(3);
  // Rewritten code is not a prefix: nothing stale is reused.
  expect(liveFenceLines('m:0', 'm', parseOpenFence('```ts\nz\ny\nx')!)).toEqual([]);
});

it('escapes code and leaves very long fences plain', () => {
  expect(renderOpenFence({ lang: 'html', completed: '<b>&', partial: '</b>' }, []))
    .toBe('<pre><code class="language-html"><span class="line">&lt;b&gt;&amp;</span>\n<span class="line">&lt;/b&gt;</span></code></pre>');
  const long = { lang: 'ts', completed: Array.from({ length: 401 }, (_, index) => `l${index}`).join('\n'), partial: '' };
  expect(liveFenceLines('m:1', 'm', long)).toEqual([]);
  expect(highlightLinesInWorker).not.toHaveBeenCalled();
});
