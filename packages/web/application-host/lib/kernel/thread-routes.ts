import { PlanConflict } from './plan-service.js';
import { parseThreadImages } from './thread-images.js';
import type { Express, RequestHandler } from 'express';
import type { ThreadIdentity, ThreadModel, ThreadSubmit, ThreadThinkingLevel } from '@varin/application-client';
import { KernelClientError } from './kernel-client.js';
import { ThreadAdapter } from './thread-adapter.js';
import { controlThreadFollowup, listThreadFollowups, registerThreadFollowup } from './thread-followups.js';

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
const identity = (body: Record<string, unknown>): ThreadIdentity => {
  if (body.runtime !== 'agent') throw new Error('Explicit thread runtime selection is required');
  return { runtime: 'agent', threadId: text(body.threadId), branchId: text(body.branchId) };
};
const modelSelection = (value: unknown): ThreadModel => {
  const model = object(value);
  if (Object.keys(model).some(key => !['providerId', 'modelId', 'thinkingLevel'].includes(key))) throw new Error('Unsupported model selection field');
  if (model.thinkingLevel !== undefined && (typeof model.thinkingLevel !== 'string' || !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(model.thinkingLevel))) throw new Error('Invalid thinking level');
  return { providerId: text(model.providerId), modelId: text(model.modelId),
    ...(model.thinkingLevel === undefined ? {} : { thinkingLevel: model.thinkingLevel as ThreadThinkingLevel }) };
};

/** Mounted in the existing authenticated Application Host, shared by Web and Electron. */
export function registerThreadRoutes(app: Express, adapter: ThreadAdapter, requireAuth: RequestHandler): void {
  const fields: Record<string, readonly string[]> = {
    'model/select': ['runtime','threadId','branchId','runId','key','model'],
    'permission/decide': ['runtime', 'threadId', 'branchId', 'operationId', 'permissionId', 'decision'],
    'question/answer': ['runtime', 'threadId', 'branchId', 'operationId', 'answer'],
    'source/prepare': ['runtime', 'threadId', 'branchId', 'key', 'path', 'mode'],
    'context/compact': ['runtime', 'threadId', 'branchId', 'key', 'throughId', 'expectedRevision', 'model'],
    'context/publish': ['runtime', 'threadId', 'branchId', 'runId'], 'context/cancel': ['runtime', 'threadId', 'branchId', 'runId'], 'context/resume': ['runtime', 'threadId', 'branchId', 'runId'],
    'child/report': ['runtime', 'threadId', 'branchId', 'operationId', 'itemId', 'offset', 'maxBytes'],
    'child/list': ['runtime', 'threadId', 'branchId'], 'child/cancel': ['runtime', 'threadId', 'branchId', 'operationId'],
    'child/wait/cancel': ['runtime', 'threadId', 'branchId', 'waitId'], 'tree/cancel': ['runtime', 'threadId', 'branchId'],
    'resources/refresh': ['runtime', 'threadId', 'branchId', 'expectedRevision', 'instructionDirectories', 'supportingFiles'],
    'followup/register': ['runtime', 'threadId', 'branchId', 'key', 'runId', 'operationId'],
    'followup/list': ['runtime', 'threadId', 'branchId'],
    'followup/control': ['runtime', 'threadId', 'branchId', 'followupId', 'expectedRevision', 'action'],
    'plan/read': ['runtime', 'threadId', 'branchId'],
    'plan/update': ['runtime', 'threadId', 'branchId', 'key', 'expectedHeadId', 'expectedRef', 'content'],
    fork: ['runtime', 'threadId', 'branchId', 'key', 'headId'],
    'tools/inspect':['runtime','threadId','branchId','runId'],
    'policy/inspect': ['runtime','threadId','branchId','runId'],
    'policy/restart': ['runtime','threadId','branchId','runId','selectionId'],
    'policy/cancel': ['runtime','threadId','branchId','runId','selectionId'],
    create: ['key'], list: [], models: [], submit: ['runtime', 'threadId', 'branchId', 'key', 'text', 'images', 'expectedHead', 'model', 'source'],
    snapshot: ['runtime', 'threadId', 'branchId'], 'history/page': ['runtime', 'threadId', 'branchId', 'headId', 'beforeId'], enqueue: ['runtime', 'threadId', 'branchId', 'key', 'text', 'images', 'mode'],
    'input/edit': ['inputId', 'expectedRevision', 'text', 'images'], 'input/cancel': ['inputId', 'expectedRevision'],
    run: ['runId'], 'run/cancel': ['runId'], 'run/resume': ['runId', 'waitId'], 'run/retry-preparation': ['runId'], operation: ['operationId'], 'operation/cancel': ['operationId'], events: ['cursor'],
  };
  const post = (method: string, action: (body: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>) => {
    app.post(`/api/threads/${method}`, requireAuth, async (request, response) => {
      const controller = new AbortController();
      const closed = () => { if (!response.writableEnded) controller.abort(new DOMException('Request closed', 'AbortError')); };
      response.once('close', closed);
      try {
        const body = object(request.body);
        if (Object.keys(body).some(key => !fields[method]!.includes(key))) throw new Error('Unsupported thread request field');
        response.json(await action(body, controller.signal));
      }
      catch (error) {
        // Errors from credentials/model services can contain upstream bodies. Do not echo them.
        const conflict = error instanceof PlanConflict || error instanceof KernelClientError && error.code === 'operation-error' && error.message.startsWith('operation error: conflict:');
        const code = conflict ? 'thread-conflict' : error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'thread-request-failed';
        response.status(code.includes('conflict') ? 409 : 400).json({ code, error: 'Thread request could not be completed' });
      } finally { response.removeListener('close', closed); }
    });
  };
  post('plan/read', (body, signal) => adapter.readPlan(identity(body), signal));
  post('plan/update', (body, signal) => {
    if (typeof body.content !== 'string') throw new Error('Plan content must be text');
    return adapter.updatePlan({ ...identity(body), key: text(body.key),
      expectedHeadId: body.expectedHeadId === null ? null : text(body.expectedHeadId),
      expectedRef: body.expectedRef === null ? null : text(body.expectedRef), content: body.content }, signal);
  });
  post('permission/decide', body => {
    if (body.decision !== 'allow_once' && body.decision !== 'deny') throw new Error('Invalid permission decision');
    return adapter.decidePermission({ ...identity(body), operationId: text(body.operationId), permissionId: text(body.permissionId), decision: body.decision });
  });
  post('question/answer', body => adapter.answerQuestion({ ...identity(body), operationId: text(body.operationId), answer: text(body.answer) }));
  post('child/report', body => adapter.readChildReport(identity(body), text(body.operationId), text(body.itemId), body.offset === undefined ? 0 : revision(body.offset), body.maxBytes === undefined ? 65536 : revision(body.maxBytes)));
  post('child/list', body => adapter.children(identity(body)));
  post('child/cancel', body => adapter.cancelChild(identity(body), text(body.operationId)));
  post('child/wait/cancel', body => adapter.cancelChildWait(identity(body), text(body.waitId)));
  post('tree/cancel', async body => { await adapter.cancelTree(identity(body)); return {}; });
  post('resources/refresh', (body, signal) => {
    let instructionDirectories: string[] | undefined;
    if (body.instructionDirectories !== undefined) {
      if (!Array.isArray(body.instructionDirectories) || !body.instructionDirectories.every(path => typeof path === 'string')) throw new Error('Invalid instruction directories');
      instructionDirectories = body.instructionDirectories;
    }
    let supportingFiles: Array<{ skillName: string; relativePath: string }> | undefined;
    if (body.supportingFiles !== undefined) {
      if (!Array.isArray(body.supportingFiles)) throw new Error('Invalid skill resource selection');
      supportingFiles = body.supportingFiles.map(value => {
        const file = object(value);
        if (Object.keys(file).some(key => key !== 'skillName' && key !== 'relativePath')) throw new Error('Invalid skill resource field');
        return { skillName: text(file.skillName), relativePath: text(file.relativePath) };
      });
    }
    return adapter.refreshResources({ ...identity(body), expectedRevision: revision(body.expectedRevision),
      ...(instructionDirectories ? { instructionDirectories } : {}), ...(supportingFiles ? { supportingFiles } : {}) }, signal);
  });
  post('followup/register', (body, signal) => registerThreadFollowup(adapter,
    { ...identity(body), key: text(body.key), runId: text(body.runId), operationId: text(body.operationId) }, signal));
  post('followup/list', (body, signal) => listThreadFollowups(adapter, identity(body), signal));
  post('followup/control', (body, signal) => {
    if (body.action !== 'pause' && body.action !== 'resume' && body.action !== 'cancel') throw new Error('Invalid follow-up control');
    return controlThreadFollowup(adapter, { ...identity(body), followupId: text(body.followupId),
      expectedRevision: revision(body.expectedRevision), action: body.action }, signal);
  });
  post('tools/inspect',(body,signal)=>adapter.inspectTools(identity(body),text(body.runId),signal));
  post('policy/inspect', body => adapter.inspectPolicy(identity(body), text(body.runId)));
  post('policy/restart', (body, signal) => adapter.restartPolicy(identity(body), text(body.runId), text(body.selectionId), signal));
  post('policy/cancel', (body, signal) => adapter.cancelPolicyUpdate(identity(body), text(body.runId), text(body.selectionId), signal));
  post('models', () => adapter.listModels());
  post('model/select',body=>adapter.selectModel({...identity(body),runId:text(body.runId),key:text(body.key),model:modelSelection(body.model)}));
  post('list', async () => (await adapter.runtime.threads()).filter(thread => thread.thread_id.startsWith('thread:')));
  post('create', body => adapter.create(text(body.key)));
  post('fork', (body, signal) => adapter.fork({ ...identity(body), key: text(body.key), headId: body.headId === null ? null : text(body.headId) }, signal));
  post('source/prepare', body => {
    if (body.mode !== 'fixed_branch' && body.mode !== 'materialized' && body.mode !== 'live_root') throw new Error('Invalid source mode');
    return adapter.prepareSource({ ...identity(body), key: text(body.key), path: text(body.path), mode: body.mode });
  });
  post('context/compact', body => {
    return adapter.compact({ ...identity(body), key: text(body.key), throughId: text(body.throughId), expectedRevision: revision(body.expectedRevision),
      model: modelSelection(body.model) });
  });
  post('context/publish', body => adapter.publishContext(identity(body), text(body.runId)));
  post('context/cancel', body => adapter.cancelContext(identity(body), text(body.runId)));
  post('context/resume', async body => { await adapter.resumeContext(identity(body), text(body.runId)); return {}; });
  post('submit', async body => {
    const images = parseThreadImages(body.images);
    if (typeof body.text !== 'string' || (!body.text.length && !images?.length)) throw new Error('Text or images are required');
    const input: ThreadSubmit = { ...identity(body), key: text(body.key), text: body.text, ...(images === undefined ? {} : { images }),
      expectedHead: body.expectedHead === null ? null : text(body.expectedHead),
      model: modelSelection(body.model) };
    if (body.source !== undefined) {
      const source = object(body.source);
      if (Object.keys(source).some(key => !['workspaceId', 'executionWorkspaceId', 'branchId', 'revision', 'mode', 'tools', 'liveRoot'].includes(key))) throw new Error('Unsupported source selection field');
      if (source.mode !== 'fixed_branch' && source.mode !== 'materialized' && source.mode !== 'live_root') throw new Error('Invalid source mode');
      if (!Array.isArray(source.tools) || source.tools.some(tool => !['file_read', 'file_list', 'file_search', 'file_write', 'file_edit', 'process_inspect', 'process_read', 'process_spawn', 'language_definition', 'language_references', 'language_diagnostics', 'code_retrieval'].includes(String(tool)))) throw new Error('Unsupported tool');
      const base = { workspaceId: text(source.workspaceId), executionWorkspaceId: text(source.executionWorkspaceId),
        tools: source.tools as NonNullable<ThreadSubmit['source']>['tools'] };
      if (source.mode === 'live_root') {
        if (source.branchId !== undefined || source.revision !== undefined) throw new Error('Live source cannot claim a fixed revision');
        const root = object(source.liveRoot);
        if (Object.keys(root).some(key => !['hostId', 'canonicalRoot', 'rootId'].includes(key))) throw new Error('Unsupported live root field');
        input.source = { ...base, mode: 'live_root', liveRoot: { hostId: text(root.hostId), canonicalRoot: text(root.canonicalRoot), rootId: text(root.rootId) } };
      } else {
        if (source.liveRoot !== undefined) throw new Error('Fixed source cannot claim a live root');
        input.source = { ...base, branchId: text(source.branchId), revision: revision(source.revision), mode: source.mode };
      }
    }
    return adapter.submit(input);
  });
  post('history/page', body => adapter.historyPage(identity(body), { headId: text(body.headId), beforeId: text(body.beforeId) }));
  post('snapshot', body => adapter.snapshot(identity(body)));
  post('enqueue', async body => {
    const selected = identity(body); await adapter.requireIdentity(selected);
    if (!['boundary', 'interrupt', 'next_run'].includes(String(body.mode))) throw new Error('Invalid input mode');
    const images = parseThreadImages(body.images);
    if (typeof body.text !== 'string' || (!body.text.length && !images?.length)) throw new Error('Text or images are required');
    return adapter.enqueue({ ...selected, key: text(body.key), text: body.text, ...(images === undefined ? {} : { images }), mode: body.mode as 'boundary' | 'interrupt' | 'next_run' });
  });
  post('input/edit', (body, signal) => {
    if (typeof body.text !== 'string') throw new Error('Input text must be a string');
    return adapter.editInput(text(body.inputId), revision(body.expectedRevision), body.text, parseThreadImages(body.images), signal);
  });
  post('input/cancel', async body => { await adapter.requireInput(text(body.inputId)); return adapter.runtime.cancelInput(text(body.inputId), revision(body.expectedRevision)); });
  post('run', body => adapter.requireRun(text(body.runId))); 
  post('run/cancel', async body => { await adapter.requireRun(text(body.runId)); return adapter.runtime.cancelRun(text(body.runId)); });
  post('run/resume', body => adapter.resume(text(body.runId), text(body.waitId)));
  post('run/retry-preparation', async body => { await adapter.retryPreparation(text(body.runId)); return {}; });
  post('operation', body => adapter.requireOperation(text(body.operationId)));
  post('operation/cancel', body => adapter.cancelOperation(text(body.operationId)));
  post('events', body => adapter.runtime.events(revision(body.cursor), 256));
  app.get('/api/threads/observe', requireAuth, (request, response) => {
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
