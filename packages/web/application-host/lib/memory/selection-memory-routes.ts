import type { Express, RequestHandler } from 'express';
import type { ChatMemoryOwner } from '@varin/application-client';
import type { PiSessionEntry } from '@varin/protocol';
import { KnowledgeMutationError, MEMORY_NATURES } from '../knowledge/store.js';
import { memoryOwnerScopeId, type MemoryService } from './memory-service.js';
import { parseSelectionMemories, SELECTION_MEMORY_SYSTEM, validateMemoryPassages } from './selection-memory.js';

export function registerSelectionMemoryRoutes(app: Express, deps: {
  memory: MemoryService;
  entries(sessionId: string): Promise<PiSessionEntry[]>;
  narrate(scopeId: string, system: string, prompt: string, signal: AbortSignal): Promise<string>;
  requireAuth: RequestHandler;
}) {
  const base = '/api/harness/sessions/:sessionId/knowledge/extracted';
  const ownerMatches = (expected: unknown, actual: ChatMemoryOwner): boolean => {
    const value = expected as Partial<ChatMemoryOwner> | null;
    return !!value && value.scope === actual.scope && value.ownerId === actual.ownerId;
  };
  const targetOwner = async (sessionId: string, target: unknown, expectedOwner: unknown) => {
    const owner = await deps.memory.ownerForSession(sessionId);
    if (!ownerMatches(expectedOwner, owner)) throw new KnowledgeMutationError('conflict', 'The conversation memory owner has changed');
    if (target === 'user') return { scope: 'user', ownerId: null } as const;
    if (target !== 'owner') throw new KnowledgeMutationError('invalid', 'Choose a memory destination');
    return owner;
  };
  const handleError = (res: import('express').Response, error: unknown) => {
    if (res.destroyed || res.writableEnded) return;
    const status = error instanceof KnowledgeMutationError
      ? error.code === 'conflict' ? 409 : error.code === 'not-found' ? 404 : 400 : 500;
    res.status(status).json({ error: error instanceof Error ? error.message : 'Memory operation failed' });
  };

  app.post(`${base}/preview`, deps.requireAuth, async (req, res) => {
    const sessionId = String(req.params.sessionId);
    const controller = new AbortController();
    const disconnect = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', disconnect);
    try {
      const owner = await deps.memory.ownerForSession(sessionId);
      const passages = validateMemoryPassages(req.body?.sources, await deps.entries(sessionId));
      controller.signal.throwIfAborted();
      const prompt = JSON.stringify({ passages: passages.map((source, index) => ({
        id: `s${index}`, role: source.role, text: source.passage.text,
      })) });
      const text = await deps.narrate(memoryOwnerScopeId(owner) ?? 'user', SELECTION_MEMORY_SYSTEM, prompt, controller.signal);
      controller.signal.throwIfAborted();
      res.json({ owner, drafts: parseSelectionMemories(text, passages) });
    } catch (error) { handleError(res, error); }
    finally { res.off('close', disconnect); }
  });

  app.post(base, deps.requireAuth, async (req, res) => {
    try {
      const sessionId = String(req.params.sessionId);
      const owner = await targetOwner(sessionId, req.body?.target, req.body?.expectedOwner);
      const draft = req.body?.draft;
      if (!draft || typeof draft.content !== 'string' || !draft.content.trim()
        || typeof draft.trigger !== 'string' || !MEMORY_NATURES.includes(draft.nature)) {
        throw new KnowledgeMutationError('invalid', 'A memory and its recall cue are required');
      }
      const sources = validateMemoryPassages(draft.sources, await deps.entries(sessionId), true);
      const result = await deps.memory.remember(owner, {
        content: draft.content, trigger: draft.trigger, nature: draft.nature,
        source: { kind: 'user-extracted', sessionId,
          spans: sources.map(({ span }) => ({ ...span, sessionId })) },
      });
      res.status(result.created ? 201 : 200).json({ created: result.created, owner, item: result.item });
    } catch (error) { handleError(res, error); }
  });

  app.delete(`${base}/:id`, deps.requireAuth, async (req, res) => {
    try {
      const sessionId = String(req.params.sessionId);
      const owner = await targetOwner(sessionId, req.body?.target, req.body?.expectedOwner);
      const id = Number(req.params.id);
      const expected = req.body?.expected;
      if (!Number.isSafeInteger(id) || id <= 0 || !expected || typeof expected.content !== 'string'
        || typeof expected.trigger !== 'string' || expected.status !== 'accepted'
        || (expected.invalidAt !== null && typeof expected.invalidAt !== 'number')) {
        throw new KnowledgeMutationError('invalid', 'The saved memory revision is required to undo');
      }
      const { item } = await deps.memory.get(owner, id);
      if (item.source?.kind !== 'user-extracted' || item.source.sessionId !== sessionId) {
        throw new KnowledgeMutationError('conflict', 'This memory was not created by this conversation extraction');
      }
      await deps.memory.forget(owner, id, expected);
      res.json({ undone: true });
    } catch (error) { handleError(res, error); }
  });
}
