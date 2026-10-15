import { getRuntimeEndpointGeneration, getRuntimeUrlResolver, runtimeFetch } from '@varin/application-client';
import { getRegisteredRuntimeAPIs } from '@/lib/runtime-api/registry';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useThreadStore } from '@/stores/useThreadStore';
import { useModelCatalogStore } from '@/stores/useModelCatalogStore';
import { useProjectsStore } from '@/stores/useProjectsStore';

declare const __APP_VERSION__: string | undefined;
type JsonRecord = Record<string, unknown>;
const record = (value: unknown): JsonRecord => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
const probe = async <T>(operation: () => Promise<T>) => {
  const startedAt = Date.now();
  try { const value = await operation(); return { elapsedMs: Date.now() - startedAt, ok: true as const, value }; }
  catch (error) { return { elapsedMs: Date.now() - startedAt, ok: false as const, error: error instanceof Error ? error.message : String(error) }; }
};
const endpointLabel = (value: string): string => {
  try { const url = new URL(value); return `${url.protocol}//${url.host}${url.pathname}`; }
  catch { return value.split(/[?#]/u)[0] ?? ''; }
};
async function healthSnapshot() {
  const endpoint = getRuntimeUrlResolver().health();
  const response = await runtimeFetch(endpoint, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
  const value = record(await response.json());
  const compatibility = record(value.compatibility);
  return { endpoint: endpointLabel(endpoint), httpStatus: response.status, httpOk: response.ok,
    status: value.status ?? null, varinVersion: value.varinVersion ?? null, serverId: value.serverId ?? null,
    runtime: value.runtime ?? null, apiVersion: compatibility.apiVersion ?? null,
    capabilities: Array.isArray(compatibility.capabilities) ? compatibility.capabilities.filter(item => typeof item === 'string') : [] };
}
/** Read-only native owner diagnostics. Prompt/history bodies, auth and provider configuration are excluded. */
export async function collectVarinDiagnostics() {
  const generation = getRuntimeEndpointGeneration();
  const threadState = useThreadStore.getState(), models = useModelCatalogStore.getState();
  const directory = useDirectoryStore.getState().currentDirectory;
  const projects = useProjectsStore.getState();
  const apis = getRegisteredRuntimeAPIs();
  const identity = threadState.selectedIdentity;
  const [health, selectedThread, git] = await Promise.all([
    probe(healthSnapshot),
    identity && apis?.threads ? probe(async () => {
      const snapshot = await apis.threads!.snapshot(identity);
      const run = snapshot.activeRun;
      return { identity: snapshot.identity, revision: snapshot.thread.revision, eventCursor: snapshot.eventCursor,
        activeRun: run ? { id: run.id, state: run.state, cancelRequested: run.cancel_requested, epoch: run.epoch } : null,
        historyLoaded: snapshot.history.length, queuedInputs: snapshot.inputs.length,
        operations: snapshot.operations.map(operation => ({ id: operation.id, phase: operation.phase, cancelRequested: operation.cancel_requested })),
        recovery: snapshot.recovery ? { unavailable: snapshot.recovery.unavailable ?? null,
          combinedUnavailable: snapshot.recovery.combinedUnavailable ?? null, operationCount: snapshot.recovery.operations.length } : null };
    }) : Promise.resolve({ ok: false as const, skipped: true, error: 'No selected native Thread' }),
    directory && apis ? probe(() => apis.git.checkIsGitRepository(directory))
      : Promise.resolve({ ok: false as const, skipped: true, error: 'No admitted working directory' }),
  ]);
  if (generation !== getRuntimeEndpointGeneration()) throw new Error('Application Host changed while collecting diagnostics; refresh on the selected Host.');
  return {
    app: { name: 'Varin', version: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : null, generatedAt: new Date().toISOString() },
    runtime: { health, surface: apis?.runtime ?? null },
    catalogs: { threads: { loaded: threadState.catalogLoaded, loading: threadState.catalogLoading, error: threadState.catalogError,
      total: threadState.threads.length, archived: threadState.threads.filter(thread => thread.archived).length },
      models: { loaded: models.loaded, loading: models.loading, error: models.error,
        channels: models.channels.map(channel => ({ id: channel.id, type: channel.type, enabled: channel.enabled,
          models: channel.models.map(model => ({ id: model.id, enabled: model.enabled, operations: model.operations })) })) } },
    context: { selectedThread, projectId: projects.activeProjectId, projectCount: projects.projects.length },
    integrations: { git },
    userAgent: typeof navigator === 'undefined' ? null : navigator.userAgent,
    windowOrigin: typeof window === 'undefined' ? null : window.location.origin,
  };
}
export const buildVarinDiagnosticsReport = async (): Promise<string> => JSON.stringify(await collectVarinDiagnostics(), null, 2);
