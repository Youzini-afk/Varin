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
 * Native facts loader uses the framework-neutral research API and explicit source
 * selection. Views read the
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

/** A retained native source Run selects the original research authority. */
export type ResearchFactsOwner = {
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

/**
 * Returns `null` when the native research source is unavailable — an
 * empty snapshot would falsely claim "no experiments" for a scope that does
 * not exist yet.
 */
export const loadResearchFacts = async (
  owner: ResearchFactsOwner,
  signal?: AbortSignal,
): Promise<ResearchFactsSnapshot | null> => {
    const { api, selection } = owner;
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
  };

export const loadResearchAttemptDetails = async (
  owner: ResearchFactsOwner,
  attemptId: string,
  signal?: AbortSignal,
): Promise<ResearchAttemptDetails | null> => {
    const body = await owner.api.get(owner.selection, attemptId, signal);
    const attempt = nativeAttempt(body.attempt);
    if (attempt.attemptId !== attemptId || !Array.isArray(body.artifacts)) throw new Error('Research details belong to another attempt');
    const job = body.job === undefined ? undefined : parseJob(body.job);
    if (body.job !== undefined && (!job || job.attemptId !== attemptId)) throw new Error('Research job is malformed');
    return { attempt, ...(job ? { job } : {}), artifacts: body.artifacts.map(value => {
      const artifact = parseArtifact(value);
      if (!artifact || artifact.attemptId !== attemptId) throw new Error('Research artifact is malformed'); return artifact;
    }) };
  };

export const loadResearchAttemptLogs = async (
  owner: ResearchFactsOwner,
  attemptId: string,
  options: { stream: 'stdout' | 'stderr'; offset?: number; maxBytes?: number },
  signal?: AbortSignal,
): Promise<ExperimentLogsResult | null> => {
    const result = await owner.api.logs(owner.selection, { attemptId, ...options }, signal);
    if (result.attemptId !== attemptId || result.stream !== options.stream || result.offset !== (options.offset ?? 0)
      || typeof result.text !== 'string' || !Number.isSafeInteger(result.nextOffset) || result.nextOffset < result.offset
      || typeof result.eof !== 'boolean') throw new Error('Research log page is malformed');
    return result;
  };

export const loadResearchArtifact = async (
  owner: ResearchFactsOwner,
  attemptId: string,
  artifactId: string,
  signal?: AbortSignal,
): Promise<Blob> => {
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let offset = 0;
    for (;;) {
      signal?.throwIfAborted();
      const page = await owner.api.artifact(owner.selection, { attemptId, artifactId, offset }, signal);
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
  };

export const cancelResearchAttempt = async (owner: ResearchFactsOwner, attemptId: string): Promise<void> => {
    const result = await owner.api.cancel(owner.selection, attemptId);
    if (nativeAttempt(result.attempt).attemptId !== attemptId) throw new Error('Cancellation belongs to another attempt');
    return;
  };

export const cancelResearchAttempts = async (
  owner: ResearchFactsOwner,
  attemptIds: string[],
): Promise<ResearchBatchCancelItem[]> => { return Promise.all(attemptIds.map(async attemptId => {
    try { await cancelResearchAttempt(owner, attemptId); return { attemptId, ok: true }; }
    catch (error) { return { attemptId, ok: false, error: error instanceof Error ? error.message : String(error) }; }
  })); };

export const rerunResearchAttempt = async (
  owner: ResearchFactsOwner,
  attemptId: string,
  intent: { requestId: string; machineId?: string; specId?: string },
): Promise<ExperimentSubmitResult> => {
    if (!owner.canSubmit) throw new Error('This historical research source is read/control only');
    if (!intent.specId) throw new Error('Rerun needs its original immutable spec');
    const result = await owner.api.submit(owner.selection, { requestId: intent.requestId, specId: intent.specId,
      retryOfAttemptId: attemptId, ...(intent.machineId ? { machineId: intent.machineId } : {}) });
    const attempt = nativeAttempt(result.attempt);
    if (attempt.requestId !== intent.requestId || attempt.retryOfAttemptId !== attemptId) throw new Error('Rerun receipt belongs to another intent');
    return { ...result, attempt };
  };

export const rerunResearchAttempts = async (
  owner: ResearchFactsOwner,
  attempts: Array<Pick<ExperimentAttemptView, 'attemptId' | 'machineId'> & { specId: string; requestId: string }>,
): Promise<ResearchBatchRerunItem[]> => { return Promise.all(attempts.map(async (attempt, index) => {
    try {
      const result = await rerunResearchAttempt(owner, attempt.attemptId, attempt);
      return { index, requestId: attempt.requestId, accepted: true, ...result };
    } catch (error) { return { index, requestId: attempt.requestId, accepted: false, error: error instanceof Error ? error.message : String(error) }; }
  })); };

export const collectResearchAttempt = async (owner: ResearchFactsOwner, attemptId: string): Promise<ExperimentCollectResult> => {
    const result = await owner.api.collect(owner.selection, attemptId);
    const attempt = nativeAttempt(result.attempt);
    if (attempt.attemptId !== attemptId || !Array.isArray(result.artifacts)) throw new Error('Collection receipt is malformed');
    return { attempt, artifacts: result.artifacts.map(value => {
      const artifact = parseArtifact(value);
      if (!artifact || artifact.attemptId !== attemptId) throw new Error('Collected artifact is malformed'); return artifact;
    }) };
  };
