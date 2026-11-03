import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { NativeBrowserHost } from './native-page.js';

/** Caller supplies a separate RequestContext, never the interactive Browser Use session. */
export async function renderNativeWebPage(native: NativeBrowserHost, rawUrl: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<{ html: string; finalUrl: string; timedOut: boolean }> {
  const url = new URL(rawUrl.trim());
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http(s) URLs are supported');
  options.signal?.throwIfAborted();
  const page = await native.create(randomUUID());
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let rejectAbort: (error: unknown) => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const abort = () => { void Promise.resolve(page.stop()).catch(() => undefined); rejectAbort(options.signal?.reason ?? new Error('Web render aborted')); };
  options.signal?.addEventListener('abort', abort, { once: true });
  const timeoutMs = typeof options.timeoutMs === 'number' && options.timeoutMs > 0 ? Math.min(options.timeoutMs, 30_000) : 20_000;
  const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { timedOut = true; reject(new Error('Web render timed out')); }, timeoutMs); });
  try {
    if (options.signal?.aborted) abort();
    const rendering = (async () => {
      await page.page.goto(url.href, { waitUntil: 'load', timeout: 0 });
      await delay(1000, undefined, options.signal ? { signal: options.signal } : undefined);
      options.signal?.throwIfAborted();
      const html = await page.page.content();
      return { html, finalUrl: page.page.url() || url.href, timedOut: false };
    })();
    return await Promise.race([rendering, aborted, timeout]);
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason ?? error;
    // A rendering failure must not be silently relabelled as a timeout.
    if (!timedOut) throw error;
    return { html: '', finalUrl: page.page.url() || url.href, timedOut: true };
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    await page.browser.disconnect();
    // The original page must actually close before releasing rendering work.
    await page.close();
  }
}
