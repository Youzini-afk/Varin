import { net, type Session } from 'electron';
import { Readable } from 'node:stream';

const responseHeaders = (raw: Record<string, string | string[]>): Headers => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    for (const part of Array.isArray(value) ? value : [value]) headers.append(name, part);
  }
  return headers;
};

/** One HTTP hop through Chromium's system proxy/PAC stack. Electron's
 * Session.fetch rejects manual redirects; ClientRequest exposes their status
 * and location before following, so the Host can inspect each next URL. */
export const createDesktopNetworkFetch = (networkSession: Session) => (
  url: string,
  init: RequestInit,
): Promise<Response> => new Promise((resolve, reject) => {
  let prepared: Request;
  try { prepared = new Request(url, init); }
  catch (error) { reject(error); return; }
  const outbound = net.request({
    url,
    method: prepared.method,
    session: networkSession,
    redirect: 'manual',
    cache: 'no-store',
    useSessionCookies: false,
    bypassCustomProtocolHandlers: true,
  });
  let settled = false;
  const fail = (error: unknown): void => {
    if (settled) return;
    settled = true;
    reject(error);
  };
  const onAbort = (): void => {
    outbound.abort();
    fail(init.signal?.reason ?? new Error('request aborted'));
  };
  if (init.signal?.aborted) { onAbort(); return; }
  init.signal?.addEventListener('abort', onAbort, { once: true });
  outbound.on('close', () => init.signal?.removeEventListener('abort', onAbort));
  outbound.on('error', fail);
  outbound.on('redirect', (statusCode, _method, redirectUrl, rawHeaders) => {
    if (settled) return;
    const headers = responseHeaders(rawHeaders);
    if (!headers.has('location')) headers.set('location', redirectUrl);
    settled = true;
    resolve(new Response(null, { status: statusCode, headers }));
    outbound.abort();
  });
  outbound.on('response', (incoming) => {
    if (settled) return;
    const status = incoming.statusCode;
    if (status < 200 || status > 599) {
      fail(new Error(`invalid HTTP response status ${status}`));
      outbound.abort();
      return;
    }
    const noBody = prepared.method === 'HEAD' || status === 204 || status === 205 || status === 304;
    // Electron's declaration lists EventEmitter, but its runtime response is
    // a Node Readable (verified in the main process). Preserve backpressure.
    const body = noBody ? null : Readable.toWeb(incoming as unknown as Readable) as ReadableStream<Uint8Array>;
    settled = true;
    resolve(new Response(body, { status, headers: responseHeaders(incoming.headers) }));
  });
  for (const [name, value] of prepared.headers) outbound.setHeader(name, value);
  if (!prepared.body) { outbound.end(); return; }
  outbound.chunkedEncoding = true;
  void (async () => {
    const reader = prepared.body!.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done || init.signal?.aborted) break;
      outbound.write(Buffer.from(value));
    }
    if (!init.signal?.aborted) outbound.end();
  })().catch((error) => { fail(error); outbound.abort(); });
});
