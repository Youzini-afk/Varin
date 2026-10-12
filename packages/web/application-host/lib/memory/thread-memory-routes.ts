import type { Express, RequestHandler } from 'express';
import type { ThreadMemoryAPI } from '@varin/application-client';
import { KnowledgeMutationError } from '../knowledge/store.js';
import { MemoryInferenceError } from './memory-inference.js';
export function registerThreadMemoryRoutes(app: Express, memory: ThreadMemoryAPI, requireAuth: RequestHandler): void {
    for (const action of ['preview', 'save', 'undo'] as const)
        app.post(`/api/bot-memory/${action}`, requireAuth, async (req, res) => {
            const controller = new AbortController();
            const disconnect = () => { if (!res.writableEnded)
                controller.abort(); };
            res.on('close', disconnect);
            try {
                if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))
                    throw new KnowledgeMutationError('invalid', 'Memory request must be an object');
                const result = action === 'preview' ? await memory.preview(req.body, controller.signal)
                    : action === 'save' ? await memory.save(req.body) : await memory.undo(req.body);
                if (!res.destroyed && !res.writableEnded)
                    res.json(result);
            }
            catch (error) {
                if (res.destroyed || res.writableEnded)
                    return;
                const status = error instanceof KnowledgeMutationError ? error.code === 'conflict' ? 409 : error.code === 'not-found' ? 404 : 400 : 500;
                res.status(status).json({ code: error instanceof MemoryInferenceError ? error.code : error instanceof KnowledgeMutationError ? error.code : 'memory-unavailable',
                    error: error instanceof Error ? error.message : 'Memory operation failed',
                    ...(action === 'preview' ? { requestKey: req.body?.requestKey ?? null, retryDisposition: error instanceof MemoryInferenceError ? error.retryDisposition : error instanceof KnowledgeMutationError ? 'none' : 'observe' } : {}) });
            }
            finally {
                res.off('close', disconnect);
            }
        });
}
