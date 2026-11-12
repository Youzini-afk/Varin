import { assertRequestAccess } from './request-principal.js';
import type { Express, RequestHandler } from 'express';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import type { ThreadIdentity } from '@varin/application-client';
import { HarnessServiceError } from '../harness/service-error.js';
import type { ThreadAttachmentOwner } from './thread-attachments.js';

/** Raw bytes bypass JSON/base64 bodies and preserve the existing HTTP backpressure. */
export function registerThreadAttachmentRoutes(app: Express, owner: ThreadAttachmentOwner, requireAuth: RequestHandler): void {
  const string = (value: unknown): string => {
    if (typeof value !== 'string' || !value.length) throw new HarnessServiceError('invalid-params', 'Attachment identity is required');
    return value;
  };
  const identity = (query: Record<string, unknown>): ThreadIdentity => {
    if (query.runtime !== 'agent') throw new HarnessServiceError('invalid-params', 'Select the attachment Thread');
    return { runtime: 'agent', threadId: string(query.threadId), branchId: string(query.branchId) };
  };
  for (const method of ['upload', 'read'] as const) {
    app[method === 'upload' ? 'post' : 'get'](`/api/threads/attachments/${method}`, requireAuth, async (request, response) => {
      const controller = new AbortController();
      const close = () => { if (!response.writableEnded) controller.abort(new DOMException('Attachment observer closed', 'AbortError')); };
      response.once('close', close);
      try {
        const query = request.query as Record<string, unknown>;
        const selected = identity(query);
        await assertRequestAccess({ threads: [selected.threadId] }, method === 'upload' ? 'write' : 'read');
        if (method === 'upload') {
          if (request.headers['content-type']?.split(';')[0] !== 'application/octet-stream') throw new HarnessServiceError('invalid-params', 'Send original attachment bytes as an octet stream');
          const byteLength = Number(string(query.byteLength));
          const result = await owner.upload(selected, { key: string(query.key), filename: string(query.filename), mimeType: typeof query.mimeType === 'string' ? query.mimeType : '', byteLength }, request, controller.signal);
          if (!response.destroyed) response.json(result);
        } else {
          const result = await owner.read(selected, string(query.ref), controller.signal);
          response.set({ 'Content-Type': result.attachment.mimeType, 'Content-Length': String(result.attachment.byteLength),
            'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(result.attachment.filename)}`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
          await pipeline(Readable.from(result.stream), response, { signal: controller.signal });
        }
      } catch (error) {
        if (response.destroyed || controller.signal.aborted) return;
        if (response.headersSent) { response.destroy(); return; }
        const code = error instanceof HarnessServiceError ? error.harnessCode : error && typeof error === 'object' && 'code' in error && error.code === 'forbidden' ? 'forbidden' : 'attachment-unavailable';
        response.status(code === 'forbidden' ? 403 : code === 'not-found' ? 404 : code === 'conflict' ? 409 : code === 'invalid-params' ? 400 : 503)
          .json({ code, error: error instanceof HarnessServiceError ? error.message : 'The original attachment owner is unavailable' });
      } finally { response.off('close', close); }
    });
  }
}
