import type { Express, RequestHandler } from 'express';
import express from 'express';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { EgressFetch } from '../harness/egress.js';

/** Explicit image editing reads use the Host's outbound policy, including redirects/proxies.
 * No browser/provider credentials are forwarded to the image source. */
export function registerImageReadRoute(app: Express, requireAuth: RequestHandler, fetchImage: EgressFetch) {
  app.post('/api/images/read', requireAuth, express.json(), async (request, response) => {
    let url: URL;
    try { url = new URL(request.body?.url); if (!['http:', 'https:'].includes(url.protocol)) throw new Error('protocol'); }
    catch { response.status(400).json({ code: 'image-url-invalid' }); return; }
    const controller = new AbortController();
    const stop = () => { if (!response.writableFinished) controller.abort(); };
    response.once('close', stop);
    let upstream: Response | undefined;
    try {
      upstream = await fetchImage(url.href, { signal: controller.signal, headers: { accept: 'image/*' } });
      const contentType = upstream.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
      if (!upstream.ok || !contentType?.startsWith('image/') || !upstream.body) {
        await upstream.body?.cancel(); response.status(502).json({ code: 'image-source-unavailable' }); return;
      }
      response.set({ 'Content-Type': contentType, 'Cache-Control': 'no-store', 'Content-Disposition': 'attachment',
        'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" });
      await pipeline(Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream<Uint8Array>), response, { signal: controller.signal });
    } catch {
      if (!controller.signal.aborted && !response.headersSent) response.status(502).json({ code: 'image-source-unavailable' });
      else if (!response.destroyed) response.destroy();
    } finally { response.removeListener('close', stop); }
  });
}
