import { THINKING_LEVELS, isWorkFocusId } from '@varin/protocol';
import { parseThreadMaterials } from './thread-material-input.js';
import { normalizeThreadSourcePreparation, parseSourceResourceOwner } from './thread-sources.js';
import { threadSourceFailureMessage } from '@varin/application-client';
import { sourceFailureCode } from './source-admission-error.js';
import type { McpElicitationResponse, McpSamplingRequestAction, McpSamplingOutputAction } from '@varin/protocol';
import type { OutputMediaHolder } from '@varin/protocol';
import { parseComputerWorkRef, parseComputerExecutionRef } from '@varin/protocol';
import type { FamilyListParams,FamilyRunsParams, FamilyReadParams, FamilyItemParams, FollowupRegistrationTrigger } from '@varin/protocol';
import { PlanConflict } from './plan-service.js';
import { parseThreadImages } from './thread-images.js';
import { parseClientTime } from './thread-message-time.js';
import type { Express, RequestHandler } from 'express';
import type { ThreadIdentity, ThreadModel, ThreadSubmit, ThreadThinkingLevel, ThreadResearchAPI, ThreadResearchSelection, ThreadComputerAPI, ThreadMaterialsAPI, ThreadMaterialReadRequest, ThreadMaterialSourceReadRequest, ThreadMaterialArtifactReadRequest } from '@varin/application-client';
import { ComputerError } from '../computer/computer-error.js';
import { HarnessServiceError } from '../harness/service-error.js';
import { KernelClientError } from './kernel-client.js';
import { ThreadAdapter, ThreadPreAdmissionError } from './thread-adapter.js';
import { WorkspaceBackendUnavailableError } from './native-workspaces.js';
import { listThreadFollowupJobs, pendingThreadFollowupRegistrations, cancelThreadFollowupRegistration, controlThreadFollowup, getThreadFollowup, getThreadFollowupOccurrence, listThreadFollowupOccurrences, listThreadFollowups, registerThreadFollowup } from './thread-followups.js';
import { controlThreadGoal, listThreadGoals, startThreadGoal, updateThreadGoal } from './thread-goals.js';

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
/** Rust owns the nested query decoder and family authorization; Host owns caller identity. */
const familyRequest = <T>(value: unknown): Omit<T, 'callerThreadId'> => {
  const request = object(value);
  if ('callerThreadId' in request) throw new Error('Family caller is the authenticated Thread identity');
  return request as Omit<T, 'callerThreadId'>;
};
/** Rust owns leaf decoding and condition semantics. Host needs only a safe flat
 * traversal to acquire original-source authority for actual file paths. */
const followupTrigger = (value: unknown): FollowupRegistrationTrigger => {
  const trigger = object(value);
  if (trigger.kind === 'any' || trigger.kind === 'all') {
    if (!Array.isArray(trigger.sources)) throw new Error('Follow-up conditions must be an array');
    for (const source of trigger.sources) object(source);
  }
  return trigger as unknown as FollowupRegistrationTrigger;
};
const goalBudget = (value: unknown): { maxOutputTokens: number } | null => {
  if (value === null) return null;
  const budget = object(value);
  if (Object.keys(budget).some(key => key !== 'maxOutputTokens')
    || !Number.isSafeInteger(budget.maxOutputTokens) || Number(budget.maxOutputTokens) < 0) {
    throw new Error('Goal output-token budget must be a non-negative integer');
  }
  return { maxOutputTokens: Number(budget.maxOutputTokens) };
};
const modelSelection = (value: unknown): ThreadModel => {
  const model = object(value);
  if (Object.keys(model).some(key => !['providerId', 'modelId', 'thinkingLevel', 'temperature'].includes(key))) throw new Error('Unsupported model selection field');
  if (model.temperature !== undefined && (typeof model.temperature !== 'number' || !Number.isFinite(model.temperature) || model.temperature < 0)) throw new Error('Invalid temperature');
  if (model.thinkingLevel !== undefined && (typeof model.thinkingLevel !== 'string' || !(THINKING_LEVELS as readonly string[]).includes(model.thinkingLevel))) throw new Error('Invalid thinking level');
  return { providerId: text(model.providerId), modelId: text(model.modelId),
    ...(model.thinkingLevel === undefined ? {} : { thinkingLevel: model.thinkingLevel as ThreadThinkingLevel }),
    ...(model.temperature === undefined ? {} : { temperature: model.temperature as number }) };
};

const inputBeforeAdmission = <T>(decode: () => T): T => {
  try { return decode(); } catch (error) { throw new ThreadPreAdmissionError(error, 'thread-request-failed'); }
};

/** Mounted in the existing authenticated Application Host, shared by Web and Electron. */
export function registerThreadRoutes(app: Express, adapter: ThreadAdapter, requireAuth: RequestHandler, research?: ThreadResearchAPI, computer?: ThreadComputerAPI, materials?: ThreadMaterialsAPI,
  integrations?: Pick<ReturnType<typeof import('./thread-integrations.js').createThreadIntegrations>, 'submit'>): void {
  const fields: Record<string, readonly string[]> = {
    'next-step': ['runtime', 'threadId', 'branchId', 'runId', 'headId'],
    'child/integration': ['runtime', 'threadId', 'branchId', 'key', 'executionId', 'publicationId', 'action', 'sourceOwner', 'expectedBindingFingerprint', 'resolutions', 'operationId', 'sourceRunId'],
    'materials/upload': ['runtime', 'threadId', 'branchId', 'request'],
    'materials/read': ['runtime', 'threadId', 'branchId', 'request'],
    'materials/collection': ['runtime', 'threadId', 'branchId', 'request'],
    'materials/read-source': ['runtime', 'threadId', 'branchId', 'sourceRunId', 'request'],
    'materials/read-artifact': ['runtime', 'threadId', 'branchId', 'sourceRunId', 'request'],
    'media/read': ['runtime', 'threadId', 'branchId', 'holder', 'partIndex', 'chunkIndex', 'expectedContentRef'],
    'computer/decide': ['runtime', 'threadId', 'branchId', 'requestId', 'expectedRevision', 'decision', 'key', 'reason'],
    'computer/state': ['runtime', 'threadId', 'branchId'],
    'computer/stop': ['runtime', 'threadId', 'branchId', 'runId', 'desktopId'],
    'research/scopes': ['runtime', 'threadId', 'branchId'],
    'research/list': ['runtime', 'threadId', 'branchId', 'sourceRunId', 'request'],
    'research/get': ['runtime', 'threadId', 'branchId', 'sourceRunId', 'attemptId'],
    'research/logs': ['runtime', 'threadId', 'branchId', 'sourceRunId', 'request'],
    'research/artifact': ['runtime', 'threadId', 'branchId', 'sourceRunId', 'request'],
    'research/cancel': ['runtime', 'threadId', 'branchId', 'sourceRunId', 'attemptId'],
    'research/collect': ['runtime', 'threadId', 'branchId', 'sourceRunId', 'attemptId'],
    'research/submit': ['runtime', 'threadId', 'branchId', 'sourceRunId', 'request'],
    'research/resources': ['runtime', 'threadId', 'branchId', 'sourceRunId'],
    'research/sources': ['runtime', 'threadId', 'branchId', 'sourceRunId', 'request'],
    'process/terminal': ['runtime', 'threadId', 'branchId', 'operationId'],
    'model/select': ['runtime','threadId','branchId','runId','key','model'],
    'permission/decide': ['runtime', 'threadId', 'branchId', 'operationId', 'permissionId', 'decision'],
    'question/answer': ['runtime', 'threadId', 'branchId', 'operationId', 'answers'],
    'mcp/interactions/list': ['runtime', 'threadId', 'branchId', 'cursor', 'limit'],
    'mcp/interactions/read': ['runtime', 'threadId', 'branchId', 'operationId', 'interactionId'],
    'mcp/interactions/respond': ['runtime', 'threadId', 'branchId', 'operationId', 'interactionId', 'expectedRevision', 'response'],
    'mcp/interactions/sampling/request': ['runtime', 'threadId', 'branchId', 'operationId', 'interactionId', 'expectedRevision', 'action', 'model', 'editedRequest'],
    'mcp/interactions/sampling/output': ['runtime', 'threadId', 'branchId', 'operationId', 'interactionId', 'expectedRevision', 'action'],
    'source/list': ['runtime', 'threadId', 'branchId'],
    'source/resolve': ['runtime', 'threadId', 'branchId', 'resourceOwner', 'path'],
    'source/prepare': ['resourceOwner', 'runtime', 'threadId', 'branchId', 'key', 'workspaceId', 'mode', 'content', 'captureScopes'],
    'context/compact': ['runtime', 'threadId', 'branchId', 'key', 'throughId', 'expectedRevision', 'model'],
    'context/history': ['runtime', 'threadId', 'branchId', 'runId', 'headId', 'beforeId'],
    'history/file': ['runtime', 'threadId', 'branchId', 'itemId', 'path'],
    'context/publish': ['runtime', 'threadId', 'branchId', 'runId'], 'context/cancel': ['runtime', 'threadId', 'branchId', 'runId'], 'context/resume': ['runtime', 'threadId', 'branchId', 'runId'],
    'messages/send': ['runtime', 'threadId', 'branchId', 'request'],
    'messages/list': ['runtime', 'threadId', 'branchId', 'request'],
    'messages/feed': ['runtime', 'threadId', 'branchId', 'request'],
    'messages/exchange': ['runtime', 'threadId', 'branchId', 'request'],
    'messages/get': ['runtime', 'threadId', 'branchId', 'messageId'],
    'family/list': ['runtime', 'threadId', 'branchId', 'includeSelf', 'scope', 'query', 'cursor', 'limit', 'parentThreadId', 'parentBranchId', 'workspaceId', 'updatedAfterMs', 'updatedBeforeMs', 'filePath'],
    'family/runs': ['runtime', 'threadId', 'branchId', 'request'],
    'family/read': ['runtime', 'threadId', 'branchId', 'request'],
    'family/item': ['runtime', 'threadId', 'branchId', 'request'],
    'child/continue': ['runtime', 'threadId', 'branchId', 'key', 'name', 'sourceAgent', 'previousRunId', 'expectedHead', 'text', 'images', 'materials', 'clientTime'],
    'child/executions': ['runtime', 'threadId', 'branchId', 'operationId'],
    'child/execution/report': ['runtime', 'threadId', 'branchId', 'executionId', 'itemId', 'offset', 'maxBytes'],
    'child/report': ['runtime', 'threadId', 'branchId', 'operationId', 'itemId', 'offset', 'maxBytes'],
    'child/list': ['runtime', 'threadId', 'branchId'], 'child/page':['runtime','threadId','branchId','options'], 'child/cancel': ['runtime', 'threadId', 'branchId', 'operationId'],
    'child/wait/cancel': ['runtime', 'threadId', 'branchId', 'waitId'], 'tree/cancel': ['runtime', 'threadId', 'branchId'],
    'resources/refresh': ['runtime', 'threadId', 'branchId', 'expectedRevision', 'instructionDirectories', 'supportingFiles'],
    'followup/jobs': ['runtime', 'threadId', 'branchId', 'runId'],
    'followup/registrations/pending': ['runtime', 'threadId', 'branchId'],
    'followup/registration/cancel': ['runtime', 'threadId', 'branchId', 'key', 'runId'],
    'followup/register': ['runtime', 'threadId', 'branchId', 'key', 'runId', 'trigger', 'instruction', 'repeat'],
    'followup/occurrence': ['runtime', 'threadId', 'branchId', 'followupId', 'occurrenceId'],
    'followup/occurrences': ['runtime', 'threadId', 'branchId', 'followupId', 'after'],
    'followup/get': ['runtime', 'threadId', 'branchId', 'followupId'],
    'followup/list': ['runtime', 'threadId', 'branchId'],
    'followup/control': ['runtime', 'threadId', 'branchId', 'followupId', 'expectedRevision', 'action'],
    'goal/start': ['runtime', 'threadId', 'branchId', 'key', 'runId', 'objective', 'budget'],
    'goal/update': ['runtime', 'threadId', 'branchId', 'goalId', 'expectedRevision', 'objective', 'budget'],
    'goal/control': ['runtime', 'threadId', 'branchId', 'goalId', 'expectedRevision', 'action'],
    'goal/list': ['runtime', 'threadId', 'branchId'],
    'plan/read': ['runtime', 'threadId', 'branchId'],
    'plan/update': ['runtime', 'threadId', 'branchId', 'key', 'expectedHeadId', 'expectedRef', 'content'],
    'recovery/source': ['runtime', 'threadId', 'branchId', 'entryId'],
    'navigation/prepare': ['runtime', 'threadId', 'branchId', 'entryId'],
    navigate: ['runtime', 'threadId', 'branchId', 'key', 'expectedHeadId', 'targetHeadId', 'undoOf'],
    'navigation/receipt': ['runtime', 'threadId', 'branchId', 'key'],
    fork: ['runtime', 'threadId', 'branchId', 'key', 'headId'],
    'tools/inspect':['runtime','threadId','branchId','runId'],
    'policy/inspect': ['runtime','threadId','branchId','runId'],
    'policy/restart': ['runtime','threadId','branchId','runId','selectionId'],
    'policy/cancel': ['runtime','threadId','branchId','runId','selectionId'],
    update: ['runtime', 'threadId', 'key', 'expectedRevision', 'title', 'pinned', 'archived'],
    delete: ['runtime', 'threadId', 'key', 'expectedRevision'],
    read: ['runtime', 'threadId', 'key', 'throughCursor'],
    create: ['key'], list: ['query', 'archived'], models: [], submit: ['runtime', 'threadId', 'branchId', 'key', 'text', 'images', 'materials', 'expectedHead', 'model', 'source', 'agent', 'clientTime'],
    usage: ['runtime', 'threadId', 'branchId'],
    'context/inspect': ['runtime', 'threadId', 'branchId', 'headId'],
    snapshot: ['runtime', 'threadId', 'branchId'], 'history/page': ['runtime', 'threadId', 'branchId', 'headId', 'beforeId', 'limit'],
    'history/runs': ['runtime', 'threadId', 'branchId', 'headId'], 'history/run-preview': ['runtime', 'threadId', 'branchId', 'headId', 'runId'],
    'history/usage': ['runtime', 'threadId', 'branchId', 'headId', 'beforeId', 'limit'], enqueue: ['runtime', 'threadId', 'branchId', 'key', 'text', 'images', 'materials', 'mode', 'clientTime'],
    'input/edit': ['inputId', 'expectedRevision', 'text', 'images'], 'input/cancel': ['inputId', 'expectedRevision'],
    'input/send-now': ['inputId', 'expectedRevision', 'expectedRunId'],
    run: ['runId'], 'run/cancel': ['runId'], 'run/resume': ['runId', 'waitId'], 'run/retry-preparation': ['runId'], operation: ['operationId'], 'operation/cancel': ['operationId'], events: ['cursor'],
  };
  fields['operation/calls'] = ['operationId'];
  fields['operation/retrieval-trace'] = ['operationId', 'headId', 'beforeId'];
  fields['operation/retrieval-file'] = ['operationId', 'itemId', 'path'];
  const post = (method: string, action: (body: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>) => {
    app.post(`/api/threads/${method}`, requireAuth, async (request, response) => {
      const controller = new AbortController();
      const closed = () => { if (!response.writableEnded) controller.abort(new DOMException('Request closed', 'AbortError')); };
      response.once('close', closed);
      try {
        let body: Record<string, unknown>;
        try {
          body = object(request.body);
          if (Object.keys(body).some(key => !fields[method]!.includes(key))) throw new Error('Unsupported thread request field');
          if (method.startsWith('computer/')) {
            const work = parseComputerWorkRef(body);
            if (work.runtime !== 'agent') throw new Error('Agent Thread required');
            if (method === 'computer/stop') parseComputerExecutionRef({ work, runId: body.runId });
            if (method === 'computer/decide' && (typeof body.requestId !== 'string' || !body.requestId.trim()
              || !Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 1
              || body.decision !== 'grant' && body.decision !== 'deny' || typeof body.key !== 'string' || !body.key.trim()
              || body.reason !== undefined && typeof body.reason !== 'string')) throw new Error('Invalid Computer decision');
            if (body.desktopId !== undefined && (typeof body.desktopId !== 'string' || !body.desktopId.trim())) throw new Error('Desktop must be nonempty');
          }
        } catch (error) {
          if (method.startsWith('computer/')) throw new ComputerError('computer-request-invalid', 'Choose an Agent Thread and branch; Stop also requires the exact Run shown in its Computer state');
          throw new ThreadPreAdmissionError(error, 'thread-request-failed');
        }
        response.json(await action(body, controller.signal));
      }
      catch (error) {
        // Errors from credentials/model services can contain upstream bodies. Do not echo them.
        const reason = error instanceof ThreadPreAdmissionError ? error.reason : error;
        if (reason instanceof WorkspaceBackendUnavailableError) {
          response.status(503).json({ code: reason.code, error: reason.message, admission: 'not_started' }); return;
        }
        const sourceCode = sourceFailureCode(error instanceof ThreadPreAdmissionError ? error.reason : error);
        const admission = error instanceof ThreadPreAdmissionError ? { admission: 'not_started' as const } : {};
        if (sourceCode) { response.status(sourceCode === 'source_authority_denied' ? 403 : sourceCode === 'source_registration_missing' ? 404 : 409).json({ code: sourceCode, error: threadSourceFailureMessage(sourceCode), ...admission }); return; }
        const conflict = error instanceof PlanConflict || error instanceof KernelClientError && error.code === 'operation-error' && error.message.startsWith('operation error: conflict:');
        if (error instanceof ComputerError) { response.status(error.computerCode === 'computer-work-not-found' ? 404 : error.computerCode === 'computer-execution-stale' ? 409 : error.computerCode === 'computer-request-invalid' ? 400 : 503).json({ code: error.computerCode, error: error.message }); return; }
        const suppliedCode = conflict ? 'thread-conflict' : error instanceof HarnessServiceError ? error.harnessCode
          : error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'thread-request-failed';
        const code = threadSourceFailureMessage(suppliedCode) ? 'thread-request-failed' : suppliedCode;
        const status = code.includes('conflict') ? 409 : code === 'denied' || code === 'forbidden' ? 403
          : code === 'not-found' ? 404 : code === 'unavailable' || code === 'timeout' ? 503 : 400;
        response.status(status).json({ code, error: code === 'agent-profile-unavailable' ? 'The selected Agent is unavailable. Choose an enabled Agent for this work focus.' : 'Thread request could not be completed',
          ...admission });
      } finally { response.removeListener('close', closed); }
    });
  };
  const selection = (body: Record<string, unknown>): ThreadResearchSelection => ({ ...identity(body), sourceRunId: text(body.sourceRunId) });
  if (materials) {
    if (materials.collection) post('materials/collection', (body, signal) => materials.collection!(identity(body), object(body.request) as Parameters<NonNullable<ThreadMaterialsAPI['collection']>>[1], signal));
    // The material owner validates the request and derives its domain from the real Thread.
    post('materials/upload', (body, signal) => materials.upload(identity(body), object(body.request) as unknown as import('@varin/application-client').ThreadMaterialUpload, signal));
    post('materials/read', (body, signal) => materials.read(identity(body), object(body.request) as ThreadMaterialReadRequest, signal));
    post('materials/read-source', (body, signal) => materials.readSource(selection(body), object(body.request) as ThreadMaterialSourceReadRequest, signal));
    post('materials/read-artifact', (body, signal) => materials.readArtifact(selection(body), object(body.request) as ThreadMaterialArtifactReadRequest, signal));
  }
  if (computer) {
    post('computer/decide', (body, signal) => computer.decide(identity(body), { requestId: text(body.requestId), expectedRevision: Number(body.expectedRevision), decision: body.decision as 'grant' | 'deny', key: text(body.key), ...(body.reason === undefined ? {} : { reason: body.reason as string }) }, signal));
    post('computer/state', (body, signal) => computer.state(identity(body), signal));
    post('computer/stop', body => computer.stop(identity(body), { runId: text(body.runId), ...(body.desktopId === undefined ? {} : { desktopId: text(body.desktopId) }) }));
  }
  if (research) {
    const request = <T>(value: unknown, allowed: readonly string[]): T => {
      const input = object(value);
      if (Object.keys(input).some(key => !allowed.includes(key))) throw new Error('Unsupported research request field');
      return input as T;
    };
    post('research/scopes', (body, signal) => research.scopes(identity(body), signal));
    post('research/list', (body, signal) => research.list(selection(body), request(body.request, ['state', 'specId', 'limit']), signal));
    post('research/get', (body, signal) => research.get(selection(body), text(body.attemptId), signal));
    post('research/logs', (body, signal) => research.logs(selection(body), request(body.request, ['attemptId', 'stream', 'offset', 'maxBytes']), signal));
    post('research/artifact', (body, signal) => research.artifact(selection(body), request(body.request, ['attemptId', 'artifactId', 'offset', 'maxBytes']), signal));
    // Cancelling a response reader never requests job cancellation. These are explicit commands.
    post('research/cancel', body => research.cancel(selection(body), text(body.attemptId)));
    post('research/collect', body => research.collect(selection(body), text(body.attemptId)));
    post('research/submit', body => {
      const input = request<Parameters<ThreadResearchAPI['submit']>[1]>(body.request,
        ['requestId', 'retryOfAttemptId', 'title', 'specId', 'command', 'args', 'cwd', 'env', 'inputs', 'resources', 'outputPaths', 'machineId']);
      text(input.requestId);
      return research.submit(selection(body), input);
    });
    post('research/resources', (body, signal) => research.resources(selection(body), signal));
    post('research/sources', (body, signal) => research.sources(selection(body), request(body.request, ['kind']), signal));
  }
  post('process/terminal', body => adapter.openProcessTerminal({ ...identity(body), operationId: text(body.operationId) }));
  if (integrations) post('child/integration', body => {
    const common = { ...identity(body), key: text(body.key), executionId: text(body.executionId), publicationId: text(body.publicationId),
      ...(body.sourceOwner === undefined ? {} : { sourceOwner: { ownerId: text(object(body.sourceOwner).ownerId), generation: revision(object(body.sourceOwner).generation) } }) };
    if (body.action === 'preview') return integrations.submit({ ...common, action: 'preview' });
    if (body.action === 'undo') return integrations.submit({ ...common, action: 'undo', operationId: text(body.operationId), sourceRunId: text(body.sourceRunId) });
    if (body.action !== 'apply' || !Array.isArray(body.resolutions)) throw new Error('Invalid integration action');
    const resolutions = body.resolutions.map(value => {
      const entry = object(value);
      if (!['parent', 'child', 'base', 'text'].includes(String(entry.choice))) throw new Error('Invalid conflict choice');
      if (entry.choice === 'text' && typeof entry.text !== 'string') throw new Error('Text resolution requires text');
      return { path: text(entry.path), choice: entry.choice as import('@varin/protocol').ThreadConflictResolution['choice'],
        ...(typeof entry.text === 'string' ? { text: entry.text } : {}), expectedParentRevision: text(entry.expectedParentRevision),
        ...(entry.expectedLocalEditRevision === undefined ? {} : { expectedLocalEditRevision: revision(entry.expectedLocalEditRevision) }) };
    });
    return integrations.submit({ ...common, action: 'apply', expectedBindingFingerprint: text(body.expectedBindingFingerprint), resolutions });
  });
  post('plan/read', (body, signal) => adapter.readPlan(identity(body), signal));
  post('plan/update', (body, signal) => {
    if (typeof body.content !== 'string') throw new Error('Plan content must be text');
    return adapter.updatePlan({ ...identity(body), key: text(body.key),
      expectedHeadId: body.expectedHeadId === null ? null : text(body.expectedHeadId),
      expectedRef: body.expectedRef === null ? null : text(body.expectedRef), content: body.content }, signal);
  });
  post('mcp/interactions/list', (body, signal) => adapter.listMcpInteractions({ ...identity(body),
    ...(body.cursor === undefined ? {} : { cursor: text(body.cursor) }), ...(body.limit === undefined ? {} : { limit: revision(body.limit) }) }, signal));
  post('mcp/interactions/read', (body, signal) => adapter.readMcpInteraction({ ...identity(body),
    operationId: text(body.operationId), interactionId: text(body.interactionId) }, signal));
  // The original interaction owner decodes and validates the response against its saved request.
  post('mcp/interactions/respond', (body, signal) => adapter.respondMcpInteraction({ ...identity(body),
    operationId: text(body.operationId), interactionId: text(body.interactionId), expectedRevision: revision(body.expectedRevision),
    response: body.response as McpElicitationResponse }, signal));
  // The owner validates the complete request. The route only admits public identity/selection shapes.
  post('mcp/interactions/sampling/request', (body, signal) => {
    const target = { ...identity(body), operationId: text(body.operationId), interactionId: text(body.interactionId),
      expectedRevision: revision(body.expectedRevision) };
    if (body.action === 'generate') return adapter.reviewMcpSamplingRequest({ ...target, action: 'generate',
      model: modelSelection(body.model), editedRequest: object(body.editedRequest) }, signal);
    if (body.model !== undefined || body.editedRequest !== undefined) throw new Error('Only generation accepts a model and reviewed request');
    return adapter.reviewMcpSamplingRequest({ ...target, action: text(body.action) as Exclude<McpSamplingRequestAction, 'generate'> }, signal);
  });
  post('mcp/interactions/sampling/output', (body, signal) => adapter.reviewMcpSamplingOutput({ ...identity(body),
    operationId: text(body.operationId), interactionId: text(body.interactionId), expectedRevision: revision(body.expectedRevision),
    action: text(body.action) as McpSamplingOutputAction }, signal));
  post('permission/decide', body => {
    if (body.decision !== 'allow_once' && body.decision !== 'allow_always' && body.decision !== 'deny') throw new Error('Invalid permission decision');
    return adapter.decidePermission({ ...identity(body), operationId: text(body.operationId), permissionId: text(body.permissionId), decision: body.decision });
  });
  post('question/answer', body => {
    if (!Array.isArray(body.answers)) throw new Error('Question answers must be an array');
    return adapter.answerQuestion({ ...identity(body), operationId: text(body.operationId), answers: body.answers as import('@varin/protocol').QuestionAnswer[] });
  });
  post('messages/send', (body, signal) => {
    const request = object(body.request);
    if (Object.keys(request).some(key => !['key', 'targetThreadId', 'targetBranchId', 'replyTo', 'kind', 'text'].includes(key))) throw new Error('Invalid message field');
    if ((request.kind !== 'inform' && request.kind !== 'request') || typeof request.text !== 'string') throw new Error('Invalid message content');
    return adapter.sendMessage(identity(body), { key: text(request.key), kind: request.kind, text: request.text,
      ...(request.targetThreadId === undefined ? {} : { targetThreadId: text(request.targetThreadId) }),
      ...(request.targetBranchId === undefined ? {} : { targetBranchId: text(request.targetBranchId) }),
      ...(request.replyTo === undefined ? {} : { replyTo: text(request.replyTo) }) }, signal);
  });
  post('messages/list', (body, signal) => {
    const request = object(body.request);
    if (Object.keys(request).some(key => !['direction', 'cursor', 'limit'].includes(key))) throw new Error('Invalid message listing field');
    if (request.direction !== 'incoming' && request.direction !== 'outgoing') throw new Error('Invalid message direction');
    return adapter.listMessages(identity(body), { direction: request.direction,
      ...(request.cursor === undefined ? {} : { cursor: text(request.cursor) }),
      ...(request.limit === undefined ? {} : { limit: revision(request.limit) }) }, signal);
  });
  post('messages/get', (body, signal) => adapter.getMessage(identity(body), text(body.messageId), signal));
  post('messages/feed', (body, signal) => {
    const request = object(body.request);
    if (Object.keys(request).some(key => !['before', 'after', 'limit'].includes(key))) throw new Error('Invalid message feed field');
    return adapter.messageFeed(identity(body), {
      ...(request.before === undefined ? {} : { before: revision(request.before) }),
      ...(request.after === undefined ? {} : { after: revision(request.after) }),
      ...(request.limit === undefined ? {} : { limit: revision(request.limit) }),
    }, signal);
  });
  post('messages/exchange', (body, signal) => {
    const request = object(body.request);
    if (Object.keys(request).some(key => !['messageId', 'senderThreadId', 'senderBranchId', 'path'].includes(key))) throw new Error('Invalid file exchange read field');
    return adapter.codeExchange(identity(body), { messageId: text(request.messageId), senderThreadId: text(request.senderThreadId), senderBranchId: text(request.senderBranchId),
      ...(request.path === undefined ? {} : { path: text(request.path) }) }, signal);
  });
  post('family/list', (body, signal) => {
    if (body.includeSelf !== undefined && typeof body.includeSelf !== 'boolean') throw new Error('includeSelf must be boolean');
    return adapter.familyList(identity(body), { ...(body.includeSelf===undefined?{}:{includeSelf:body.includeSelf}),
      ...(body.parentThreadId===undefined?{}:{parentThreadId:text(body.parentThreadId)}),
      ...(body.parentBranchId===undefined?{}:{parentBranchId:text(body.parentBranchId)}),
      ...(body.workspaceId===undefined?{}:{workspaceId:text(body.workspaceId)}),
      ...(body.filePath===undefined?{}:{filePath:text(body.filePath)}),
      ...(body.updatedAfterMs===undefined?{}:{updatedAfterMs:revision(body.updatedAfterMs)}),
      ...(body.updatedBeforeMs===undefined?{}:{updatedBeforeMs:revision(body.updatedBeforeMs)}),
      ...(body.scope===undefined?{}:{scope:text(body.scope)}), ...(body.query===undefined?{}:{query:text(body.query)}),
      ...(body.cursor===undefined?{}:{cursor:text(body.cursor)}), ...(body.limit===undefined?{}:{limit:revision(body.limit)}) }, signal);
  });
  post('family/runs', (body, signal) => adapter.familyRuns(identity(body), familyRequest<FamilyRunsParams>(body.request), signal));
  post('family/read', (body, signal) => adapter.familyRead(identity(body), familyRequest<FamilyReadParams>(body.request), signal));
  post('family/item', (body, signal) => adapter.familyItem(identity(body), familyRequest<FamilyItemParams>(body.request), signal));
  post('child/continue', (body, signal) => {
    const input = inputBeforeAdmission(() => {
      if (typeof body.text !== 'string') throw new Error('Input text is required');
      const images = parseThreadImages(body.images);
      const materials = parseThreadMaterials(body.materials);
      return { ...identity(body), key: text(body.key), previousRunId: text(body.previousRunId),
        ...(body.name===undefined?{}:{name:text(body.name)}),
        ...(body.sourceAgent===undefined?{}:{sourceAgent:text(body.sourceAgent)}),
        expectedHead: body.expectedHead === null ? null : text(body.expectedHead), text: body.text,
        ...(body.clientTime === undefined ? {} : { clientTime: parseClientTime(body.clientTime)! }),
        ...(images === undefined ? {} : { images }), ...(materials === undefined ? {} : { materials }) };
    });
    return adapter.continueChild(input, signal);
  });
  post('child/executions', (body, signal) => adapter.childExecutions(identity(body), body.operationId === undefined ? undefined : text(body.operationId), signal));
  post('child/execution/report', (body, signal) => adapter.readChildExecutionReport(identity(body), text(body.executionId), text(body.itemId),
    body.offset === undefined ? 0 : revision(body.offset), body.maxBytes === undefined ? 65536 : revision(body.maxBytes), signal));
  post('child/report', (body, signal) => adapter.readChildReport(identity(body), text(body.operationId), text(body.itemId), body.offset === undefined ? 0 : revision(body.offset), body.maxBytes === undefined ? 65536 : revision(body.maxBytes), signal));
  post('child/list', body => adapter.children(identity(body)));
  post('child/page',(body,signal)=>adapter.childPage(identity(body),familyRequest<Omit<FamilyListParams,'callerThreadId'>>(body.options??{}),signal));
  post('child/cancel', body => adapter.cancelChild(identity(body), text(body.operationId)));
  post('child/wait/cancel', body => adapter.cancelChildWait(identity(body), text(body.waitId)));
  post('tree/cancel', body => adapter.cancelTree(identity(body)));
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
  post('followup/jobs', (body, signal) => listThreadFollowupJobs(adapter, identity(body), text(body.runId), signal));
  post('followup/registrations/pending', (body, signal) => pendingThreadFollowupRegistrations(adapter, identity(body), signal));
  post('followup/registration/cancel', (body, signal) => cancelThreadFollowupRegistration(adapter, { ...identity(body), key: text(body.key), runId: text(body.runId) }, signal));
  post('followup/register', (body, signal) => {
    if (body.repeat !== undefined && body.repeat !== 'once' && body.repeat !== 'each') throw new Error('Invalid follow-up repetition');
    return registerThreadFollowup(adapter, { ...identity(body), key: text(body.key), runId: text(body.runId),
      trigger: followupTrigger(body.trigger), instruction: text(body.instruction),
      ...(body.repeat === undefined ? {} : { repeat: body.repeat }) }, signal);
  });
  post('followup/occurrence', (body, signal) => getThreadFollowupOccurrence(adapter, identity(body), text(body.followupId), text(body.occurrenceId), signal));
  post('followup/occurrences', (body, signal) => listThreadFollowupOccurrences(adapter, identity(body), text(body.followupId),
    body.after === undefined ? undefined : revision(body.after), signal));
  post('followup/get', (body, signal) => getThreadFollowup(adapter, identity(body), text(body.followupId), signal));
  post('followup/list', (body, signal) => listThreadFollowups(adapter, identity(body), signal));
  post('followup/control', (body, signal) => {
    if (body.action !== 'pause' && body.action !== 'resume' && body.action !== 'cancel') throw new Error('Invalid follow-up control');
    return controlThreadFollowup(adapter, { ...identity(body), followupId: text(body.followupId),
      expectedRevision: revision(body.expectedRevision), action: body.action }, signal);
  });
  post('goal/start', (body, signal) => startThreadGoal(adapter, { ...identity(body), key: text(body.key),
    runId: text(body.runId), objective: text(body.objective), budget: goalBudget(body.budget) }, signal));
  post('goal/update', (body, signal) => updateThreadGoal(adapter, { ...identity(body), goalId: text(body.goalId),
    expectedRevision: revision(body.expectedRevision), objective: text(body.objective), budget: goalBudget(body.budget) }, signal));
  post('goal/control', (body, signal) => {
    if (body.action !== 'pause' && body.action !== 'resume' && body.action !== 'complete' && body.action !== 'cancel') {
      throw new Error('Invalid Goal control');
    }
    return controlThreadGoal(adapter, { ...identity(body), goalId: text(body.goalId),
      expectedRevision: revision(body.expectedRevision), action: body.action }, signal);
  });
  post('goal/list', (body, signal) => listThreadGoals(adapter, identity(body), signal));
  post('tools/inspect',(body,signal)=>adapter.inspectTools(identity(body),text(body.runId),signal));
  post('policy/inspect', body => adapter.inspectPolicy(identity(body), text(body.runId)));
  post('policy/restart', (body, signal) => adapter.restartPolicy(identity(body), text(body.runId), text(body.selectionId), signal));
  post('policy/cancel', (body, signal) => adapter.cancelPolicyUpdate(identity(body), text(body.runId), text(body.selectionId), signal));
  post('models', () => adapter.listModels());
  post('model/select',body=>adapter.selectModel({...identity(body),runId:text(body.runId),key:text(body.key),model:modelSelection(body.model)}));
  const catalogIdentity = (body: Record<string, unknown>): import('@varin/application-client').ThreadCatalogIdentity => {
    if (body.runtime !== 'agent') throw new Error('Explicit Thread runtime selection is required');
    return { runtime: 'agent', threadId: text(body.threadId) };
  };
  post('list', (body, signal) => {
    if (body.query !== undefined && typeof body.query !== 'string') throw new Error('Search query must be a string');
    if (body.archived !== undefined && !['exclude', 'include', 'only'].includes(String(body.archived))) throw new Error('Invalid archive filter');
    return adapter.list(body as import('@varin/application-client').ThreadListOptions, signal);
  });
  post('update', body => {
    for (const field of ['pinned', 'archived']) if (body[field] !== undefined && typeof body[field] !== 'boolean') throw new Error('Thread flag must be boolean');
    return adapter.update({ ...catalogIdentity(body), key: text(body.key), expectedRevision: revision(body.expectedRevision),
      ...(body.title === undefined ? {} : { title: text(body.title) }),
      ...(body.pinned === undefined ? {} : { pinned: body.pinned as boolean }),
      ...(body.archived === undefined ? {} : { archived: body.archived as boolean }) });
  });
  post('delete', body => adapter.delete({ ...catalogIdentity(body), key: text(body.key), expectedRevision: revision(body.expectedRevision) }));
  post('read', body => adapter.markRead({ ...catalogIdentity(body), key: text(body.key), throughCursor: revision(body.throughCursor) }));
  post('create', body => adapter.create(text(body.key)));
  post('recovery/source', (body, signal) => adapter.recoverySource({ ...identity(body), entryId: text(body.entryId) }, signal));
  post('navigation/prepare', (body, signal) => adapter.prepareNavigation({ ...identity(body), entryId: text(body.entryId) }, signal));
  post('navigation/receipt', (body, signal) => adapter.navigationReceipt({ ...identity(body), key: text(body.key) }, signal));
  post('navigate', (body, signal) => adapter.navigate({ ...identity(body), key: text(body.key), expectedHeadId: body.expectedHeadId === null ? null : text(body.expectedHeadId), targetHeadId: body.targetHeadId === null ? null : text(body.targetHeadId), ...(body.undoOf === undefined ? {} : { undoOf: text(body.undoOf) }) }, signal));
  post('fork', (body, signal) => adapter.fork({ ...identity(body), key: text(body.key), headId: body.headId === null ? null : text(body.headId) }, signal));
  post('source/list', (body, signal) => adapter.listSourceTargets(Object.keys(body).length ? identity(body) : null, signal));
  post('source/resolve', (body, signal) => adapter.resolveSource(identity(body), { resourceOwner: parseSourceResourceOwner(body.resourceOwner), path: text(body.path) }, signal));
  post('source/prepare', (body, signal) => {
    if (body.mode !== 'fixed_branch' && body.mode !== 'materialized' && body.mode !== 'live_root'&&body.mode!=='native_workspace') throw new Error('Invalid source mode');
    return adapter.prepareSource(normalizeThreadSourcePreparation({ ...identity(body), resourceOwner: parseSourceResourceOwner(body.resourceOwner), key: text(body.key), workspaceId: text(body.workspaceId), mode: body.mode,
      content: body.content, captureScopes: body.captureScopes } as import('@varin/application-client').ThreadPrepareSource), signal);
  });
  post('context/compact', (body, signal) => {
    return adapter.compact({ ...identity(body), key: text(body.key), throughId: text(body.throughId), expectedRevision: revision(body.expectedRevision),
      model: modelSelection(body.model) }, signal);
  });
  post('context/publish', body => adapter.publishContext(identity(body), text(body.runId)));
  post('context/history', body => adapter.contextHistory(identity(body), text(body.runId),
    body.headId === undefined && body.beforeId === undefined ? undefined : { headId: text(body.headId), beforeId: text(body.beforeId) }));
  post('context/cancel', body => adapter.cancelContext(identity(body), text(body.runId)));
  post('context/resume', async body => { await adapter.resumeContext(identity(body), text(body.runId)); return {}; });
  post('submit', async body => {
    const input = inputBeforeAdmission(() => {
      const images = parseThreadImages(body.images);
      const materials = parseThreadMaterials(body.materials);
      if (typeof body.text !== 'string' || (!body.text.length && !images?.length && !materials?.length)) throw new Error('Text, images or materials are required');
      const input: ThreadSubmit = { ...identity(body), key: text(body.key), text: body.text, ...(images === undefined ? {} : { images }), ...(materials === undefined ? {} : { materials }),
        ...(body.clientTime === undefined ? {} : { clientTime: parseClientTime(body.clientTime)! }),
        expectedHead: body.expectedHead === null ? null : text(body.expectedHead),
        model: modelSelection(body.model) };
      if (body.agent !== undefined) {
        const agent = object(body.agent);
        if (Object.keys(agent).some(key => !['profileId', 'workFocus'].includes(key)) || !isWorkFocusId(agent.workFocus)) throw new Error('Invalid Agent selection');
        input.agent = { profileId: agent.profileId === null ? null : text(agent.profileId), workFocus: agent.workFocus };
      }
      if (body.source !== undefined) {
        const source = object(body.source);
        if (Object.keys(source).some(key => !['resourceOwner', 'workspaceId', 'executionWorkspaceId', 'branchId', 'revision', 'mode', 'tools', 'liveRoot', 'environmentRunId','nativeScope'].includes(key))) throw new Error('Unsupported source selection field');
        if (source.mode !== 'fixed_branch' && source.mode !== 'materialized' && source.mode !== 'live_root'&&source.mode!=='native_workspace') throw new Error('Invalid source mode');
        if(source.nativeScope!==undefined&&(source.mode!=='native_workspace'||typeof source.nativeScope!=='string'||!source.nativeScope.split('/').every(part=>part&&part!=='.'&&part!=='..'&&!part.includes('\\'))))throw new Error('Invalid native source scope');
        if (source.environmentRunId !== undefined && source.mode !== 'materialized') throw new Error('Only a materialized source has an execution environment');
        // The kernel resolves names against the same tool declarations used for admission.
        if (!Array.isArray(source.tools) || source.tools.some(tool => typeof tool !== 'string' || !tool.length)) throw new Error('Tool names must be non-empty strings');
        const base = { resourceOwner: parseSourceResourceOwner(source.resourceOwner), workspaceId: text(source.workspaceId), executionWorkspaceId: text(source.executionWorkspaceId),
          tools: source.tools as NonNullable<ThreadSubmit['source']>['tools'] };
        if (source.mode === 'live_root') {
          if (source.branchId !== undefined || source.revision !== undefined) throw new Error('Live source cannot claim a fixed revision');
          const root = object(source.liveRoot);
          if (Object.keys(root).some(key => !['hostId', 'canonicalRoot', 'rootId'].includes(key))) throw new Error('Unsupported live root field');
          input.source = { ...base, mode: 'live_root', liveRoot: { hostId: text(root.hostId), canonicalRoot: text(root.canonicalRoot), rootId: text(root.rootId) } };
        } else if(source.mode==='native_workspace'){
          if(source.liveRoot!==undefined||source.revision!==undefined)throw new Error('Native source has no frozen revision or stored mount path');
          input.source={...base,mode:'native_workspace',branchId:text(source.branchId),...(source.nativeScope===undefined?{}:{nativeScope:source.nativeScope as string})};
        } else {
          if (source.liveRoot !== undefined) throw new Error('Fixed source cannot claim a live root');
          input.source = { ...base, branchId: text(source.branchId), revision: revision(source.revision), mode: source.mode, ...(source.environmentRunId === undefined ? {} : { environmentRunId: text(source.environmentRunId) }) };
        }
      }
      return input;
    });
    return adapter.submit(input);
  });
  post('history/page', (body, signal) => adapter.historyPage(identity(body), { headId: text(body.headId), beforeId: text(body.beforeId), ...(body.limit === undefined ? {} : { limit: Number(body.limit) }) }, signal));
  post('history/runs', (body, signal) => adapter.historyRuns(identity(body), { headId: body.headId === null ? null : text(body.headId) }, signal));
  post('history/run-preview', (body, signal) => adapter.historyRunPreview(identity(body), { headId: text(body.headId), runId: text(body.runId) }, signal));
  post('history/usage', (body, signal) => adapter.historyUsage(identity(body), { headId: text(body.headId), ...(body.beforeId === undefined ? {} : { beforeId: text(body.beforeId) }), ...(body.limit === undefined ? {} : { limit: Number(body.limit) }) }, signal));
  post('history/file', (body, signal) => adapter.fileTarget({ ...identity(body), itemId: text(body.itemId), path: text(body.path) }, signal));
  post('snapshot', (body, signal) => adapter.snapshot(identity(body), signal));
  post('next-step', (body, signal) => adapter.nextStep(identity(body), text(body.runId), text(body.headId), signal));
  post('context/inspect', (body, signal) => adapter.contextInspection(identity(body), { headId: body.headId === null ? null : text(body.headId) }, signal));
  post('usage', (body, signal) => adapter.usage(identity(body), signal));
  post('enqueue', async body => {
    const input = inputBeforeAdmission(() => {
      const selected = identity(body);
      if (!['boundary', 'interrupt', 'next_run'].includes(String(body.mode))) throw new Error('Invalid input mode');
      const images = parseThreadImages(body.images);
      const materials = parseThreadMaterials(body.materials);
      if (typeof body.text !== 'string' || (!body.text.length && !images?.length && !materials?.length)) throw new Error('Text, images or materials are required');
      return { ...selected, key: text(body.key), text: body.text, ...(images === undefined ? {} : { images }), ...(materials === undefined ? {} : { materials }),
        ...(body.clientTime === undefined ? {} : { clientTime: parseClientTime(body.clientTime)! }), mode: body.mode as 'boundary' | 'interrupt' | 'next_run' };
    });
    return adapter.enqueue(input);
  });
  post('media/read', (body, signal) => adapter.mediaRead(identity(body), {
    holder: object(body.holder) as unknown as OutputMediaHolder,
    partIndex: revision(body.partIndex), chunkIndex: revision(body.chunkIndex), expectedContentRef: text(body.expectedContentRef),
  }, signal));
  post('input/edit', (body, signal) => {
    if (typeof body.text !== 'string') throw new Error('Input text must be a string');
    return adapter.editInput(text(body.inputId), revision(body.expectedRevision), body.text, parseThreadImages(body.images), signal);
  });
  post('input/cancel', async body => { await adapter.requireInput(text(body.inputId)); return adapter.runtime.cancelInput(text(body.inputId), revision(body.expectedRevision)); });
  post('input/send-now', (body, signal) => adapter.sendInputNow(text(body.inputId), revision(body.expectedRevision), text(body.expectedRunId), signal));
  post('run', body => adapter.requireRun(text(body.runId))); 
  post('run/cancel', async body => { await adapter.requireRun(text(body.runId)); return adapter.runtime.cancelRun(text(body.runId)); });
  post('run/resume', body => adapter.resume(text(body.runId), text(body.waitId)));
  post('run/retry-preparation', async body => { await adapter.retryPreparation(text(body.runId)); return {}; });
  post('operation', body => adapter.requireOperation(text(body.operationId)));
  post('operation/calls', async (body, signal) => {
    const operationId = text(body.operationId);
    await adapter.requireOperation(operationId);
    return adapter.runtime.toolCalls(operationId, signal);
  });
  post('operation/cancel', body => adapter.cancelOperation(text(body.operationId)));
  post('operation/retrieval-file', (body, signal) => adapter.retrievalFileTarget(text(body.operationId), text(body.itemId), text(body.path), signal));
  post('operation/retrieval-trace', (body, signal) => adapter.retrievalTrace(text(body.operationId),
    body.beforeId === undefined ? undefined : { headId: text(body.headId), beforeId: text(body.beforeId) }, signal));
  post('events', body => adapter.runtime.events(revision(body.cursor), 256));
  app.get('/api/threads/observe', requireAuth, async (request, response) => {
    let cursor: number;
    if (request.query.cursor === undefined) {
      try { cursor = (await adapter.runtime.status()).eventCursor; }
      catch { response.status(503).json({ error: 'Thread observation is unavailable' }); return; }
    } else {
      try { cursor = revision(Number(request.query.cursor)); }
      catch { response.status(400).json({ error: 'Invalid event cursor' }); return; }
    }
    if (response.destroyed) return;
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
