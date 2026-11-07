import { EventEmitter } from 'node:events';
import { request as httpRequest } from 'node:http';
import { describe, it, expect, vi } from 'vitest';
import type { Page, HTTPRequest } from 'puppeteer-core';
import type { BrowserRenderRequest } from '@varin/protocol';
import { captureBrowserPage, createCaptureNetworkFence } from './browser-web-capture.js';

function request(url: string, headers: Record<string, string> = {}, method = 'GET') {
  let handled = false;
  let resolve!: () => void;
  const completed = new Promise<void>(done => { resolve = done; });
  const value = { url: () => url, headers: () => headers, method: () => method, resourceType: () => 'document',
    isInterceptResolutionHandled: () => handled,
    respond: vi.fn(async () => { handled = true; resolve(); }),
    abort: vi.fn(async () => { handled = true; resolve(); }),
  };
  return { value: value as unknown as HTTPRequest, completed, respond: value.respond, abort: value.abort };
}
function page(requests: ReturnType<typeof request>[], load?: () => Promise<void>) {
  const events = new EventEmitter();
  const operations: string[] = [];
  return { operations, value: Object.assign(events, {
    setBypassServiceWorker: async (value: boolean) => { if (value) operations.push('bypass-workers'); },
    setCacheEnabled: async (value: boolean) => { if (!value) operations.push('no-cache'); },
    setRequestInterception: async (value: boolean) => { if (value) operations.push('interception'); },
    evaluateOnNewDocument: async () => { operations.push('disable-socket-workers'); },
    goto: async () => { for (const entry of requests) { events.emit('request', entry.value); await entry.completed; } await load?.(); },
    evaluate: async () => ({ html: '<p>Captured source</p>', truncated: false }),
    url: () => 'https://example.com/final',
  }) as unknown as Page };
}
const base = { url: 'https://example.com/start', threadId: 't1', maxBytes: 1024 };

describe('read-only browser capture', () => {
  it('brokers every redirect/resource and never transfers cookie or authorization across origins', async () => {
    const same = request('https://example.com/start', { cookie: 'untrusted=1', authorization: 'Bearer own', 'proxy-authorization': 'secret' });
    const cross = request('http://127.0.0.1/script.js', { cookie: 'copied=secret', authorization: 'Bearer private' });
    const fixture = page([same, cross]);
    const fetch = vi.fn<BrowserRenderRequest['fetch']>(async () => ({ status: 200, headers: { 'content-security-policy': "default-src 'self'", 'content-disposition': 'attachment' }, body: new Uint8Array() }));
    const close = vi.fn(async () => undefined);
    const cookies = vi.fn(async () => 'owner=actual');
    const result = await captureBrowserPage({ ...base, fetch }, { page: fixture.value, signal: new AbortController().signal, cookies, close });
    expect(result).toMatchObject({ html: '<p>Captured source</p>', finalUrl: 'https://example.com/final', blockedRequests: 0 });
    expect(fixture.operations).toEqual(['bypass-workers', 'no-cache', 'interception', 'disable-socket-workers']);
    expect(fetch.mock.calls[0]![0].headers).toEqual({ cookie: 'owner=actual', authorization: 'Bearer own' });
    expect(fetch.mock.calls[1]![0].headers).toEqual({});
    expect(cookies).toHaveBeenCalledOnce();
    expect(same.respond).toHaveBeenCalledWith(expect.objectContaining({ headers: expect.objectContaining({
      'content-security-policy': expect.stringContaining("default-src 'self', worker-src 'none'"), 'x-dns-prefetch-control': 'off',
    }) }));
    expect((same.respond.mock.calls as unknown[][])[0]?.[0]).not.toHaveProperty('headers.content-disposition');
    expect(close).toHaveBeenCalledOnce();
  });

  it('blocks active methods and denied requests without falling back to browser networking', async () => {
    const post = request('https://example.com/change', {}, 'POST');
    const denied = request('https://denied.example/private');
    const fixture = page([post, denied]);
    const fetch = vi.fn<BrowserRenderRequest['fetch']>(async () => { throw new Error('domain policy'); });
    const result = await captureBrowserPage({ ...base, fetch }, { page: fixture.value, signal: new AbortController().signal, cookies: async () => '', close: async () => undefined });
    expect(fetch).toHaveBeenCalledOnce();
    expect(post.abort).toHaveBeenCalledOnce();
    expect(denied.abort).toHaveBeenCalledOnce();
    expect(result.blockedRequests).toBe(2);
  });

  it('retains original route work until cancellation has drained it', async () => {
    const slow = request('https://example.com/slow');
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const fetch = vi.fn<BrowserRenderRequest['fetch']>(async () => { await pending; throw new Error('cancelled request drained'); });
    const fixture = page([slow]);
    const controller = new AbortController();
    let settled = false;
    const close = vi.fn(async () => undefined);
    const capture = captureBrowserPage({ ...base, fetch }, { page: fixture.value, signal: controller.signal, cookies: async () => '', close }).finally(() => { settled = true; });
    const rejected = expect(capture).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    controller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await rejected;
    expect(close).toHaveBeenCalled();
  });

  it('denies direct HTTP and CONNECT attempts without opening the target', async () => {
    const fence = await createCaptureNetworkFence();
    const proxy = new URL(fence.proxyRules);
    const send = (method: string, target: string) => new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: proxy.hostname, port: proxy.port, method, path: target });
      req.on('error', reject);
      req.on('response', response => { response.resume(); response.on('end', () => resolve(response.statusCode!)); });
      req.on('connect', (response, socket) => { socket.destroy(); resolve(response.statusCode!); });
      req.end();
    });
    try {
      expect(await send('GET', 'http://127.0.0.1:1/private')).toBe(403);
      expect(await send('CONNECT', '127.0.0.1:1')).toBe(403);
      expect(fence.blocked()).toBe(2);
    } finally { await fence.close(); }
  });
});
