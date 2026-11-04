import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import type { HTTPRequest, Page } from 'puppeteer-core';
import type { BrowserRenderRequest, BrowserRenderResult } from '@varin/protocol';

/** Chromium must not fall through to a second network route (prefetch, a worker
 * or a protocol not covered by page interception). The temporary session sends
 * all such HTTP(S) connections to this deny-only endpoint. It never forwards. */
export async function createCaptureNetworkFence() {
  const sockets = new Set<Socket>();
  let blocked = 0;
  const server = createServer((_request, response) => { blocked += 1; response.writeHead(403); response.end(); });
  server.on('connect', (_request, socket) => { blocked += 1; socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); });
  server.on('upgrade', (_request, socket) => { blocked += 1; socket.destroy(); });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Cannot bind the browser capture network fence');
  return {
    proxyRules: `http://127.0.0.1:${address.port}`,
    blocked: () => blocked,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

const SAFETY_CSP = "worker-src 'none'; child-src 'none'; frame-src 'none'; object-src 'none'; connect-src http: https:; form-action 'none'";

/** No request ever calls continue(): only the original Host transport can
 * fulfill it. Draining route promises is part of the executor's stop receipt. */
export async function captureBrowserPage(input: BrowserRenderRequest, options: {
  page: Page;
  signal: AbortSignal;
  cookies(url: string): Promise<string>;
  close(): Promise<void>;
}): Promise<BrowserRenderResult> {
  const { page, signal } = options;
  const origin = new URL(input.url).origin;
  const routes = new Set<Promise<void>>();
  let blockedRequests = 0;
  let closed = false;
  const route = async (request: HTTPRequest) => {
    try {
      signal.throwIfAborted();
      const url = new URL(request.url());
      if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !['GET', 'HEAD'].includes(request.method())
        || ['websocket', 'eventsource'].includes(request.resourceType())) throw new Error('This request needs interactive Browser Use');
      const headers = { ...request.headers() };
      // Credentials never follow a redirect or leak from the original browser
      // jar to a different origin. The temporary page owns response cookies.
      for (const name of ['cookie', 'authorization', 'proxy-authorization', 'host', 'connection', 'content-length', 'accept-encoding']) delete headers[name];
      if (url.origin === origin) {
        const cookie = await options.cookies(url.href);
        if (cookie) headers.cookie = cookie;
        const authorization = request.headers().authorization;
        if (authorization) headers.authorization = authorization;
      }
      const response = await input.fetch({ url: url.href, method: request.method() as 'GET' | 'HEAD', headers }, signal);
      signal.throwIfAborted();
      const responseHeaders = { ...response.headers };
      const originalCsp = responseHeaders['content-security-policy'];
      responseHeaders['content-security-policy'] = originalCsp ? `${Array.isArray(originalCsp) ? originalCsp.join(', ') : originalCsp}, ${SAFETY_CSP}` : SAFETY_CSP;
      responseHeaders['x-dns-prefetch-control'] = 'off';
      // A passive read cannot start a file download owned by another resource.
      delete responseHeaders['content-disposition'];
      await request.respond({ status: response.status, headers: responseHeaders, body: response.body });
    } catch {
      blockedRequests += 1;
      if (!request.isInterceptResolutionHandled()) await request.abort('blockedbyclient').catch(() => undefined);
    }
  };
  const onRequest = (request: HTTPRequest) => {
    if (closed) { void request.abort('blockedbyclient').catch(() => undefined); return; }
    const promise = route(request);
    routes.add(promise);
    void promise.finally(() => routes.delete(promise));
  };
  const abort = () => { void options.close(); };
  try {
    signal.throwIfAborted();
    await page.setBypassServiceWorker(true);
    await page.setCacheEnabled(false);
    await page.setRequestInterception(true);
    await page.evaluateOnNewDocument(() => {
      for (const name of ['WebSocket', 'WebTransport', 'RTCPeerConnection', 'webkitRTCPeerConnection', 'Worker', 'SharedWorker']) {
        Object.defineProperty(globalThis, name, { configurable: false, writable: false, value: undefined });
      }
    });
    page.on('request', onRequest);
    signal.addEventListener('abort', abort, { once: true });
    await page.goto(input.url, { waitUntil: 'networkidle0', timeout: 0, signal });
    signal.throwIfAborted();
    const captured = await page.evaluate((limit: number) => {
      const html = document.documentElement.outerHTML;
      let end = Math.min(html.length, limit);
      const last = html.charCodeAt(end - 1);
      if (end < html.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
      return { html: html.slice(0, end), truncated: html.length > end };
    }, input.maxBytes);
    signal.throwIfAborted();
    return { ...captured, finalUrl: page.url(), blockedRequests };
  } finally {
    closed = true;
    signal.removeEventListener('abort', abort);
    page.off('request', onRequest);
    await options.close();
    await Promise.allSettled([...routes]);
  }
}
