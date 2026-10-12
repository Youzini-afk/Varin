import { runtimeFetch } from '@varin/application-client';
import type { ThreadMaterialsAPI, ThreadResearchAPI, ThreadResearchSelection } from '@varin/application-client';
import type {
  ExperimentArtifactView,
  ExperimentAttemptView,
  ExperimentCollectResult,
  ExperimentJobView,
  ExperimentLogsResult,
  ExperimentSubmitResult,
  ResourceMachineView,
  ResearchSourceView,
} from '@varin/protocol';

/**
 * Shared facts loader: actual Pi sessions use their harness routes; Agent Threads use
 * the framework-neutral research API and explicit source selection. Both read the
 * original experiment/resource/source owners, without a presentation-owned state store.
 */

export interface ResearchFactsSnapshot {
  attempts: ExperimentAttemptView[];
  machines: ResourceMachineView[];
  sources: ResearchSourceView[];
  generatedAt: number;
}

export interface ResearchAttemptDetails {
  attempt: ExperimentAttemptView;
  job?: ExperimentJobView;
  artifacts: ExperimentArtifactView[];
}

export interface ResearchBatchCancelItem {
  attemptId: string;
  ok: boolean;
  attempt?: ExperimentAttemptView;
  error?: string;
}

export interface ResearchBatchRerunItem {
  index: number;
  requestId: string;
  accepted: boolean;
  attempt?: ExperimentAttemptView;
  spec?: ExperimentSubmitResult['spec'];
  text?: string;
  error?: string;
}

/** A string is an actual Pi session. Native selections always carry their distinct authority. */
export type ResearchFactsOwner = string | {
  api: ThreadResearchAPI;
  materials: ThreadMaterialsAPI;
  selection: ThreadResearchSelection;
  canSubmit: boolean;
};

const nativeAttempt = (value: unknown): ExperimentAttemptView => {
  const attempt = parseAttempt(value);
  if (!attempt || !isRecord(value) || !isRecord(value.permissions) || typeof value.permissions.control !== 'boolean') {
    throw new Error('Research attempt or its permissions are malformed');
  }
  return attempt;
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const ATTEMPT_STATES = new Set([
  'submitted', 'queued', 'running', 'stopping', 'completed', 'failed', 'cancelled', 'lost',
]);

const parseAttempt = (value: unknown): ExperimentAttemptView | null => {
  if (!isRecord(value)) return null;
  if (typeof value.attemptId !== 'string' || (value.specId !== null && typeof value.specId !== 'string')) return null;
  if (typeof value.cancelRequested !== 'boolean') return null;
  if (typeof value.state !== 'string') return null;
  if (typeof value.createdAt !== 'number') return null;
  // Keep an attempt visible when a newer service adds a state. Unknown is a
  // terminal-looking fact, but it must remain distinct from known terminals
  // so the UI does not offer an action the service cannot honour.
  const state = ATTEMPT_STATES.has(value.state) ? value.state : 'unknown';
  if (value.execution !== undefined) {
    if (!isRecord(value.execution)
      || typeof value.execution.rootId !== 'string'
      || typeof value.execution.canonicalRoot !== 'string'
      || typeof value.execution.cwd !== 'string') return null;
  }
  return { ...value, state } as unknown as ExperimentAttemptView;
};

const parseArtifact = (value: unknown): ExperimentArtifactView | null => {
  if (!isRecord(value)) return null;
  if (typeof value.artifactId !== 'string' || typeof value.attemptId !== 'string') return null;
  if (typeof value.name !== 'string' || typeof value.kind !== 'string' || typeof value.state !== 'string') return null;
  return value as unknown as ExperimentArtifactView;
};

const parseJob = (value: unknown): ExperimentJobView | null => {
  if (!isRecord(value)) return null;
  if (typeof value.jobId !== 'string' || typeof value.attemptId !== 'string') return null;
  if (typeof value.backend !== 'string' || typeof value.state !== 'string') return null;
  return value as unknown as ExperimentJobView;
};

const parseMachine = (value: unknown): ResourceMachineView | null => {
  if (!isRecord(value)) return null;
  if (typeof value.machineId !== 'string' || typeof value.kind !== 'string') return null;
  if (typeof value.state !== 'string') return null;
  if (!isRecord(value.connection) || typeof value.connection.status !== 'string') return null;
  if (!Array.isArray(value.commitments) || !Array.isArray(value.queued)) return null;
  if (value.target !== undefined) {
    if (!isRecord(value.target)
      || typeof value.target.hostId !== 'string'
      || typeof value.target.connectionId !== 'string'
      || typeof value.target.source !== 'string'
      || !Array.isArray(value.target.capabilities)
      || !value.target.capabilities.every((entry) => typeof entry === 'string')
      || typeof value.target.acceptedJobsSurviveClientDisconnect !== 'boolean'
      || typeof value.target.unassignedWorkRequiresCoordinator !== 'boolean') return null;
  }
  return value as unknown as ResourceMachineView;
};

const parseSource = (value: unknown): ResearchSourceView | null => {
  if (!isRecord(value)) return null;
  if (typeof value.sourceId !== 'string' || typeof value.kind !== 'string') return null;
  if (typeof value.createdAt !== 'number') return null;
  return value as unknown as ResearchSourceView;
};

const readJson = async (response: Response): Promise<unknown> => {
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Research facts request failed (${response.status})`);
  }
  return response.json() as Promise<unknown>;
};

/**
 * Returns `null` when the session is not bound to a harness workspace — an
 * empty snapshot would falsely claim "no experiments" for a scope that does
 * not exist yet.
 */
export const loadResearchFacts = async (
  sessionId: ResearchFactsOwner,
  signal?: AbortSignal,
): Promise<ResearchFactsSnapshot | null> => {
  if (typeof sessionId !== 'string') {
    const { api, selection } = sessionId;
    const [attempts, resources, sources] = await Promise.all([
      api.list(selection, {}, signal), api.resources(selection, signal), api.sources(selection, {}, signal),
    ]);
    if (!Array.isArray(attempts.attempts) || !Array.isArray(resources.machines) || !Array.isArray(sources.sources)
      || typeof resources.generatedAt !== 'number') throw new Error('Research facts response is malformed');
    return { attempts: attempts.attempts.map(nativeAttempt),
      machines: resources.machines.map(value => {
        const machine = parseMachine(value); if (!machine) throw new Error('Resource facts are malformed'); return machine;
      }), sources: sources.sources.map(value => {
        const source = parseSource(value); if (!source) throw new Error('Source facts are malformed'); return source;
      }), generatedAt: resources.generatedAt };
  }
  const base = `/api/harness/sessions/${encodeURIComponent(sessionId)}`;
  const init: RequestInit = { cache: 'no-store', ...(signal ? { signal } : {}) };
  const [experimentsBody, resourcesBody, sourcesBody] = await Promise.all([
    runtimeFetch(`${base}/experiments`, init).then(readJson),
    runtimeFetch(`${base}/resources`, init).then(readJson),
    runtimeFetch(`${base}/sources`, init).then(readJson),
  ]);
  if (experimentsBody === null && resourcesBody === null && sourcesBody === null) return null;
  if (experimentsBody !== null && (!isRecord(experimentsBody) || !Array.isArray(experimentsBody.attempts))) {
    throw new Error('Experiment facts response is malformed');
  }
  const attempts = experimentsBody === null ? [] : (experimentsBody as { attempts: unknown[] }).attempts.map(value => {
    const attempt = parseAttempt(value);
    if (!attempt) throw new Error('Experiment facts contain an unreadable attempt');
    return attempt;
  });
  const machines = isRecord(resourcesBody) && Array.isArray(resourcesBody.machines)
    ? resourcesBody.machines.map(parseMachine).filter((entry): entry is ResourceMachineView => entry !== null)
    : [];
  const sources = isRecord(sourcesBody) && Array.isArray(sourcesBody.sources)
    ? sourcesBody.sources.map(parseSource).filter((entry): entry is ResearchSourceView => entry !== null)
    : [];
  const generatedAt = isRecord(resourcesBody) && typeof resourcesBody.generatedAt === 'number'
    ? resourcesBody.generatedAt
    : Date.now();
  return { attempts, machines, sources, generatedAt };
};

export const loadResearchAttemptDetails = async (
  sessionId: ResearchFactsOwner,
  attemptId: string,
  signal?: AbortSignal,
): Promise<ResearchAttemptDetails | null> => {
  if (typeof sessionId !== 'string') {
    const body = await sessionId.api.get(sessionId.selection, attemptId, signal);
    const attempt = nativeAttempt(body.attempt);
    if (attempt.attemptId !== attemptId || !Array.isArray(body.artifacts)) throw new Error('Research details belong to another attempt');
    const job = body.job === undefined ? undefined : parseJob(body.job);
    if (body.job !== undefined && (!job || job.attemptId !== attemptId)) throw new Error('Research job is malformed');
    return { attempt, ...(job ? { job } : {}), artifacts: body.artifacts.map(value => {
      const artifact = parseArtifact(value);
      if (!artifact || artifact.attemptId !== attemptId) throw new Error('Research artifact is malformed'); return artifact;
    }) };
  }
  const response = await runtimeFetch(
    `/api/harness/sessions/${encodeURIComponent(sessionId)}/experiments/${encodeURIComponent(attemptId)}`,
    { cache: 'no-store', ...(signal ? { signal } : {}) },
  );
  const body = await readJson(response);
  if (body === null || !isRecord(body)) return null;
  const attempt = parseAttempt(body.attempt);
  if (!attempt) throw new Error('Research attempt details are malformed');
  const job = parseJob(body.job);
  const artifacts = Array.isArray(body.artifacts)
    ? body.artifacts.map(parseArtifact).filter((entry): entry is ExperimentArtifactView => entry !== null)
    : [];
  return { attempt, ...(job ? { job } : {}), artifacts };
};

export const loadResearchAttemptLogs = async (
  sessionId: ResearchFactsOwner,
  attemptId: string,
  options: { stream: 'stdout' | 'stderr'; offset?: number; maxBytes?: number },
  signal?: AbortSignal,
): Promise<ExperimentLogsResult | null> => {
  if (typeof sessionId !== 'string') {
    const result = await sessionId.api.logs(sessionId.selection, { attemptId, ...options }, signal);
    if (result.attemptId !== attemptId || result.stream !== options.stream || result.offset !== (options.offset ?? 0)
      || typeof result.text !== 'string' || !Number.isSafeInteger(result.nextOffset) || result.nextOffset < result.offset
      || typeof result.eof !== 'boolean') throw new Error('Research log page is malformed');
    return result;
  }
  const query = new URLSearchParams({ stream: options.stream });
  if (options.offset !== undefined) query.set('offset', String(options.offset));
  if (options.maxBytes !== undefined) query.set('maxBytes', String(options.maxBytes));
  const response = await runtimeFetch(
    `/api/harness/sessions/${encodeURIComponent(sessionId)}/experiments/${encodeURIComponent(attemptId)}/logs?${query.toString()}`,
    { cache: 'no-store', ...(signal ? { signal } : {}) },
  );
  const body = await readJson(response);
  if (body === null || !isRecord(body) || typeof body.text !== 'string') return null;
  return body as unknown as ExperimentLogsResult;
};

export const loadResearchArtifact = async (
  sessionId: ResearchFactsOwner,
  attemptId: string,
  artifactId: string,
  signal?: AbortSignal,
): Promise<Blob> => {
  if (typeof sessionId !== 'string') {
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let offset = 0;
    for (;;) {
      signal?.throwIfAborted();
      const page = await sessionId.api.artifact(sessionId.selection, { attemptId, artifactId, offset }, signal);
      if (page.attemptId !== attemptId || page.artifactId !== artifactId || page.offset !== offset
        || typeof page.bytesBase64 !== 'string' || typeof page.eof !== 'boolean') throw new Error('Research artifact page is malformed');
      const bytes = Uint8Array.from(atob(page.bytesBase64), character => character.charCodeAt(0));
      if (page.nextOffset !== offset + bytes.byteLength || (!page.eof && page.nextOffset === offset)) {
        throw new Error('Research artifact cursor did not match its content');
      }
      chunks.push(bytes);
      if (page.eof) return new Blob(chunks);
      offset = page.nextOffset;
    }
  }
  const response = await runtimeFetch(
    `/api/harness/sessions/${encodeURIComponent(sessionId)}/experiments/${encodeURIComponent(attemptId)}/artifacts/${encodeURIComponent(artifactId)}`,
    { cache: 'no-store', ...(signal ? { signal } : {}) },
  );
  if (!response.ok) throw new Error(`Artifact request failed (${response.status})`);
  return response.blob();
};

export const cancelResearchAttempt = async (sessionId: ResearchFactsOwner, attemptId: string): Promise<void> => {
  if (typeof sessionId !== 'string') {
    const result = await sessionId.api.cancel(sessionId.selection, attemptId);
    if (nativeAttempt(result.attempt).attemptId !== attemptId) throw new Error('Cancellation belongs to another attempt');
    return;
  }
  const response = await runtimeFetch(
    `/api/harness/sessions/${encodeURIComponent(sessionId)}/experiments/${encodeURIComponent(attemptId)}/cancel`,
    { method: 'POST', cache: 'no-store' },
  );
  if (!response.ok) throw new Error(`Cancel failed (${response.status})`);
};

const readJsonBody = async (response: Response, message: string): Promise<Record<string, unknown>> => {
  if (!response.ok) throw new Error(`${message} (${response.status})`);
  const body = await response.json() as unknown;
  if (!isRecord(body)) throw new Error(`${message} response is malformed`);
  return body;
};

export const cancelResearchAttempts = async (
  sessionId: ResearchFactsOwner,
  attemptIds: string[],
): Promise<ResearchBatchCancelItem[]> => {
  if (typeof sessionId !== 'string') return Promise.all(attemptIds.map(async attemptId => {
    try { await cancelResearchAttempt(sessionId, attemptId); return { attemptId, ok: true }; }
    catch (error) { return { attemptId, ok: false, error: error instanceof Error ? error.message : String(error) }; }
  }));
  const response = await runtimeFetch(
    `/api/harness/sessions/${encodeURIComponent(sessionId)}/experiments/cancel-many`,
    {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attemptIds }),
    },
  );
  const body = await readJsonBody(response, 'Batch cancel failed');
  if (!Array.isArray(body.items)) throw new Error('Batch cancel response is malformed');
  return body.items.flatMap((value): ResearchBatchCancelItem[] => {
    if (!isRecord(value) || typeof value.attemptId !== 'string' || typeof value.ok !== 'boolean') return [];
    const attempt = parseAttempt(value.attempt);
    return [{
      attemptId: value.attemptId,
      ok: value.ok,
      ...(attempt ? { attempt } : {}),
      ...(typeof value.error === 'string' ? { error: value.error } : {}),
    }];
  });
};

export const rerunResearchAttempt = async (
  sessionId: ResearchFactsOwner,
  attemptId: string,
  intent: { requestId: string; machineId?: string; specId?: string },
): Promise<ExperimentSubmitResult> => {
  if (typeof sessionId !== 'string') {
    if (!sessionId.canSubmit) throw new Error('This historical research source is read/control only');
    if (!intent.specId) throw new Error('Rerun needs its original immutable spec');
    const result = await sessionId.api.submit(sessionId.selection, { requestId: intent.requestId, specId: intent.specId,
      retryOfAttemptId: attemptId, ...(intent.machineId ? { machineId: intent.machineId } : {}) });
    const attempt = nativeAttempt(result.attempt);
    if (attempt.requestId !== intent.requestId || attempt.retryOfAttemptId !== attemptId) throw new Error('Rerun receipt belongs to another intent');
    return { ...result, attempt };
  }
  const response = await runtimeFetch(
    `/api/harness/sessions/${encodeURIComponent(sessionId)}/experiments/${encodeURIComponent(attemptId)}/rerun`,
    {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId: intent.requestId,
        ...(intent.machineId ? { machineId: intent.machineId } : {}),
      }),
    },
  );
  const body = await readJsonBody(response, 'Rerun failed');
  const attempt = parseAttempt(body.attempt);
  if (!attempt || (body.spec !== null && (!isRecord(body.spec) || typeof body.spec.specId !== 'string'))) throw new Error('Rerun response is malformed');
  return { ...body, attempt, spec: body.spec as unknown as ExperimentSubmitResult['spec'] } as unknown as ExperimentSubmitResult;
};

export const rerunResearchAttempts = async (
  sessionId: ResearchFactsOwner,
  attempts: Array<Pick<ExperimentAttemptView, 'attemptId' | 'machineId'> & { specId: string; requestId: string }>,
): Promise<ResearchBatchRerunItem[]> => {
  if (typeof sessionId !== 'string') return Promise.all(attempts.map(async (attempt, index) => {
    try {
      const result = await rerunResearchAttempt(sessionId, attempt.attemptId, attempt);
      return { index, requestId: attempt.requestId, accepted: true, ...result };
    } catch (error) { return { index, requestId: attempt.requestId, accepted: false, error: error instanceof Error ? error.message : String(error) }; }
  }));
  const items = attempts.map((attempt) => ({
    requestId: attempt.requestId,
    retryOfAttemptId: attempt.attemptId,
    specId: attempt.specId,
    ...(attempt.machineId ? { machineId: attempt.machineId } : {}),
  }));
  const response = await runtimeFetch(
    `/api/harness/sessions/${encodeURIComponent(sessionId)}/experiments/submit-many`,
    {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
    },
  );
  const body = await readJsonBody(response, 'Batch rerun failed');
  if (!Array.isArray(body.items)) throw new Error('Batch rerun response is malformed');
  return body.items.flatMap((value): ResearchBatchRerunItem[] => {
    if (!isRecord(value) || typeof value.index !== 'number' || typeof value.requestId !== 'string' || typeof value.accepted !== 'boolean') throw new Error('Batch rerun item is malformed');
    const attempt = parseAttempt(value.attempt);
    const spec = value.spec === null ? null : isRecord(value.spec) && typeof value.spec.specId === 'string'
      ? value.spec as unknown as NonNullable<ExperimentSubmitResult['spec']>
      : undefined;
    if (value.accepted && (!attempt || spec === undefined)) throw new Error('Accepted rerun receipt is malformed');
    return [{
      index: value.index,
      requestId: value.requestId,
      accepted: value.accepted,
      ...(attempt ? { attempt } : {}),
      ...(spec !== undefined ? { spec } : {}),
      ...(typeof value.text === 'string' ? { text: value.text } : {}),
      ...(typeof value.error === 'string' ? { error: value.error } : {}),
    }];
  });
};

export const collectResearchAttempt = async (sessionId: ResearchFactsOwner, attemptId: string): Promise<ExperimentCollectResult> => {
  if (typeof sessionId !== 'string') {
    const result = await sessionId.api.collect(sessionId.selection, attemptId);
    const attempt = nativeAttempt(result.attempt);
    if (attempt.attemptId !== attemptId || !Array.isArray(result.artifacts)) throw new Error('Collection receipt is malformed');
    return { attempt, artifacts: result.artifacts.map(value => {
      const artifact = parseArtifact(value);
      if (!artifact || artifact.attemptId !== attemptId) throw new Error('Collected artifact is malformed'); return artifact;
    }) };
  }
  const response = await runtimeFetch(
    `/api/harness/sessions/${encodeURIComponent(sessionId)}/experiments/${encodeURIComponent(attemptId)}/collect`,
    { method: 'POST', cache: 'no-store' },
  );
  if (!response.ok) throw new Error(`Collect failed (${response.status})`);
  const body = await response.json() as unknown;
  if (!isRecord(body)) throw new Error('Collect response is malformed');
  const attempt = parseAttempt(body.attempt);
  if (!attempt) throw new Error('Collect response is missing the attempt');
  const artifacts = Array.isArray(body.artifacts)
    ? body.artifacts.map(parseArtifact).filter((entry): entry is ExperimentArtifactView => entry !== null)
    : [];
  return { attempt, artifacts };
};
