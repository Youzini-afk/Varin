import { parseNativeThreadImages, nativeThreadInput } from './native-thread-images.js';
import type { Express, RequestHandler } from 'express';
import type { NativeThreadIdentity, NativeThreadSubmit } from '@varin/application-client';
import { KernelClientError } from './kernel-client.js';
import { NativeThreadAdapter } from './native-thread-adapter.js';

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Request must be an object');
  return value as Record<string, unknown>;
};
const text = (value: unknown): string => {
  if (typeof value !== 'string' || !value.length) throw new Error('A non-empty string is required');
  return value;
};
const revision = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error('A non-negative revision is required');
  return Number(value);
};
const identity = (body: Record<string, unknown>): NativeThreadIdentity => {
  if (body.runtime !== 'nativeThread') throw new Error('Explicit nativeThread runtime selection is required');
  return { runtime: 'nativeThread', threadId: text(body.threadId), branchId: text(body.branchId) };
};

/** Mounted in the existing authenticated Application Host, shared by Web and Electron. */
export function registerNativeThreadRoutes(app: Express, adapter: NativeThreadAdapter, requireAuth: RequestHandler): void {
  const fields: Record<string, readonly string[]> = {
    'source/prepare': ['runtime', 'threadId', 'branchId', 'key', 'path', 'mode'],
    'context/compact': ['runtime', 'threadId', 'branchId', 'key', 'throughId', 'expectedRevision', 'model'],
    'context/publish': ['runtime', 'threadId', 'branchId', 'runId'], 'context/cancel': ['runtime', 'threadId', 'branchId', 'runId'], 'context/resume': ['runtime', 'threadId', 'branchId', 'runId'],
    fork: ['runtime', 'threadId', 'branchId', 'key', 'headId'],
    create: ['key'], list: [], models: [], submit: ['runtime', 'threadId', 'branchId', 'key', 'text', 'images', 'expectedHead', 'model', 'source'],
    snapshot: ['runtime', 'threadId', 'branchId'], 'history/page': ['runtime', 'threadId', 'branchId', 'headId', 'beforeId'], enqueue: ['runtime', 'threadId', 'branchId', 'key', 'text', 'images', 'mode'],
    'input/edit': ['inputId', 'expectedRevision', 'text', 'images'], 'input/cancel': ['inputId', 'expectedRevision'],
    run: ['runId'], 'run/cancel': ['runId'], 'run/resume': ['runId'], operation: ['operationId'], 'operation/cancel': ['operationId'], events: ['cursor'],
  };
  const post = (method: string, action: (body: Record<string, unknown>) => Promise<unknown>) => {
    app.post(`/api/native-threads/${method}`, requireAuth, async (request, response) => {
      try {
        const body = object(request.body);
        if (Object.keys(body).some(key => !fields[method]!.includes(key))) throw new Error('Unsupported native thread request field');
        response.json(await action(body));
      }
      catch (error) {
        // Errors from credentials/model services can contain upstream bodies. Do not echo them.
        const conflict = error instanceof KernelClientError && error.code === 'operation-error' && error.message.startsWith('operation error: conflict:');
        const code = conflict ? 'native-thread-conflict' : error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'native-thread-request-failed';
        response.status(code.includes('conflict') ? 409 : 400).json({ code, error: 'Native thread request could not be completed' });
      }
    });
  };
  post('models', () => adapter.listModels());
  post('list', async () => (await adapter.runtime.threads()).filter(thread => thread.thread_id.startsWith('nativeThread:')));
  post('create', body => adapter.create(text(body.key)));
  post('fork', body => adapter.fork({ ...identity(body), key: text(body.key), headId: body.headId === null ? null : text(body.headId) }));
  post('source/prepare', body => {
    if (body.mode !== 'fixed_branch' && body.mode !== 'materialized') throw new Error('Invalid source mode');
    return adapter.prepareSource({ ...identity(body), key: text(body.key), path: text(body.path), mode: body.mode });
  });
  post('context/compact', body => {
    const model = object(body.model);
    if (Object.keys(model).some(key => !['providerId', 'modelId'].includes(key))) throw new Error('Unsupported model selection field');
    return adapter.compact({ ...identity(body), key: text(body.key), throughId: text(body.throughId), expectedRevision: revision(body.expectedRevision),
      model: { providerId: text(model.providerId), modelId: text(model.modelId) } });
  });
  post('context/publish', body => adapter.publishContext(identity(body), text(body.runId)));
  post('context/cancel', body => adapter.cancelContext(identity(body), text(body.runId)));
  post('context/resume', async body => { await adapter.resumeContext(identity(body), text(body.runId)); return {}; });
  post('submit', async body => {
    const model = object(body.model);
    if (Object.keys(model).some(key => !['providerId', 'modelId'].includes(key))) throw new Error('Unsupported model selection field');
    const images = parseNativeThreadImages(body.images);
    if (typeof body.text !== 'string' || (!body.text.length && !images?.length)) throw new Error('Text or images are required');
    const input: NativeThreadSubmit = { ...identity(body), key: text(body.key), text: body.text, ...(images === undefined ? {} : { images }),
      expectedHead: body.expectedHead === null ? null : text(body.expectedHead),
      model: { providerId: text(model.providerId), modelId: text(model.modelId) } };
    if (body.source !== undefined) {
      const source = object(body.source);
      if (Object.keys(source).some(key => !['workspaceId', 'executionWorkspaceId', 'branchId', 'revision', 'mode', 'tools'].includes(key))) throw new Error('Unsupported source selection field');
      if (source.mode !== 'fixed_branch' && source.mode !== 'materialized') throw new Error('Invalid source mode');
      if (!Array.isArray(source.tools) || source.tools.some(tool => !['file_read', 'file_list', 'file_search', 'file_write', 'file_edit', 'process_inspect', 'process_read', 'process_spawn'].includes(String(tool)))) throw new Error('Unsupported native tool');
      input.source = { workspaceId: text(source.workspaceId), executionWorkspaceId: text(source.executionWorkspaceId),
        branchId: text(source.branchId), revision: revision(source.revision), mode: source.mode,
        tools: source.tools as NonNullable<NativeThreadSubmit['source']>['tools'] };
    }
    return adapter.submit(input);
  });
  post('history/page', body => adapter.historyPage(identity(body), { headId: text(body.headId), beforeId: text(body.beforeId) }));
  post('snapshot', body => adapter.snapshot(identity(body)));
  post('enqueue', async body => {
    const selected = identity(body); await adapter.requireIdentity(selected);
    if (!['boundary', 'interrupt', 'next_run'].includes(String(body.mode))) throw new Error('Invalid input mode');
    const images = parseNativeThreadImages(body.images);
    if (typeof body.text !== 'string' || (!body.text.length && !images?.length)) throw new Error('Text or images are required');
    return adapter.enqueue({ ...selected, key: text(body.key), text: body.text, ...(images === undefined ? {} : { images }), mode: body.mode as 'boundary' | 'interrupt' | 'next_run' });
  });
  post('input/edit', async body => {
    const queued = await adapter.requireInput(text(body.inputId));
    const images = parseNativeThreadImages(body.images);
    if (images?.length) adapter.assertImagesSupported(images, (await adapter.requireRun(queued.run_id)).configuration);
    if (typeof body.text !== 'string') throw new Error('Input text must be a string');
    // Text-only edits preserve the accepted media; explicit images replaces/removes it under CAS.
    const existing = queued.content as { attachments?: unknown[] };
    const content = images === undefined ? { ...(body.text.length || !existing.attachments?.length ? { text: body.text } : {}), ...(existing.attachments ? { attachments: existing.attachments } : {}) }
      : nativeThreadInput(body.text, images);
    if (!body.text.length && !('attachments' in content && content.attachments?.length)) throw new Error('Text or images are required');
    return adapter.runtime.editInput(queued.id, revision(body.expectedRevision), content);
  });
  post('input/cancel', async body => { await adapter.requireInput(text(body.inputId)); return adapter.runtime.cancelInput(text(body.inputId), revision(body.expectedRevision)); });
  post('run', body => adapter.requireRun(text(body.runId))); 
  post('run/cancel', async body => { await adapter.requireRun(text(body.runId)); return adapter.runtime.cancelRun(text(body.runId)); });
  post('run/resume', async body => { await adapter.resume(text(body.runId)); return {}; });
  post('operation', body => adapter.requireOperation(text(body.operationId)));
  post('operation/cancel', async body => { await adapter.requireOperation(text(body.operationId)); return adapter.runtime.cancelOperation(text(body.operationId)); });
  post('events', body => adapter.runtime.events(revision(body.cursor), 256));
  app.get('/api/native-threads/observe', requireAuth, (request, response) => {
    let cursor: number;
    try { cursor = revision(Number(request.query.cursor ?? 0)); }
    catch { response.status(400).json({ error: 'Invalid event cursor' }); return; }
    response.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    response.flushHeaders();
    const close = adapter.observe(cursor, event => {
      const writable = response.write(`data: ${JSON.stringify(event)}\n\n`);
      // A slow consumer reconnects from its durable cursor instead of retaining unbounded buffers.
      if (!writable) response.end();
      return writable;
    }, () => response.end());
    response.once('close', close);
  });
}
