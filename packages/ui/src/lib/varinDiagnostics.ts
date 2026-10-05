import type {
  PackageDescriptor,
  PiAgentCatalogSnapshot,
  PiResourceCatalogSnapshot,
  PiSessionFeatureState,
  RecoveryStatus,
  RuntimeContextTarget,
} from '@varin/protocol';
import { getRegisteredRuntimeAPIs } from '@/lib/runtime-api/registry';
import { getPiRuntimeConnection } from '@/lib/pi-runtime/client';
import { getRuntimeUrlResolver } from '@varin/application-client';
import { runtimeFetch } from '@varin/application-client';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { useProjectsStore } from '@/stores/useProjectsStore';

declare const __APP_VERSION__: string | undefined;

type DiagnosticsProbe<T> =
  | { elapsedMs: number; ok: true; value: T }
  | { elapsedMs: number; error: string; ok: false; skipped?: boolean };

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const errorMessage = (error: unknown): string => (
  error instanceof Error ? error.message : String(error)
);

const probe = async <T>(operation: () => Promise<T>): Promise<DiagnosticsProbe<T>> => {
  const startedAt = Date.now();
  try {
    const value = await operation();
    return {
      elapsedMs: Date.now() - startedAt,
      ok: true,
      value,
    };
  } catch (error) {
    return {
      elapsedMs: Date.now() - startedAt,
      error: errorMessage(error),
      ok: false,
    };
  }
};

const skippedProbe = <T>(error: string): DiagnosticsProbe<T> => ({
  elapsedMs: 0,
  error,
  ok: false,
  skipped: true,
});

const sanitizeRuntimeEndpoint = (value: string): string => {
  const withoutQuery = value.split('?')[0] ?? value;
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(withoutQuery)) return withoutQuery;
  try {
    const url = new URL(withoutQuery);
    return `${url.origin}${url.pathname}`;
  } catch {
    return withoutQuery;
  }
};

const sanitizeRuntimeKey = (value: string): string => {
  const urlIndex = value.search(/[a-z][a-z\d+.-]*:\/\//i);
  if (urlIndex < 0) return value.split('?')[0] ?? value;
  return `${value.slice(0, urlIndex)}${sanitizeRuntimeEndpoint(value.slice(urlIndex))}`;
};

const sanitizeHealthSnapshot = (value: unknown): JsonRecord | null => {
  if (!isRecord(value)) return null;
  const compatibility = isRecord(value.compatibility) ? value.compatibility : null;
  const piRuntime = isRecord(value.piRuntime) ? value.piRuntime : null;
  return {
    apiOnly: value.apiOnly ?? null,
    compatibility: compatibility
      ? {
          apiVersion: compatibility.apiVersion ?? null,
          capabilities: Array.isArray(compatibility.capabilities)
            ? compatibility.capabilities.filter((item): item is string => typeof item === 'string')
            : [],
          minClientApiVersion: compatibility.minClientApiVersion ?? null,
        }
      : null,
    varinVersion: value.varinVersion ?? null,
    piRuntime: piRuntime
      ? {
          capabilities: piRuntime.capabilities ?? null,
          hostVersion: piRuntime.hostVersion ?? null,
          nodeVersion: piRuntime.nodeVersion ?? null,
          piVersion: piRuntime.piVersion ?? null,
          protocolVersion: piRuntime.protocolVersion ?? null,
          ready: piRuntime.ready ?? null,
          source: piRuntime.source ?? null,
        }
      : null,
    runtime: value.runtime ?? null,
    serverId: value.serverId ?? null,
    status: value.status ?? null,
    timestamp: value.timestamp ?? null,
  };
};

const summarizePackages = (packages: PackageDescriptor[]) => ({
  installed: packages.filter((entry) => entry.installed).length,
  packages: packages.map((entry) => ({
    enabled: entry.enabled,
    installed: entry.installed,
    name: entry.name,
    scope: entry.scope,
    structured: entry.structured,
    version: entry.version ?? null,
  })),
  total: packages.length,
});

const summarizeResources = (catalog: PiResourceCatalogSnapshot) => ({
  active: catalog.resources.filter((entry) => entry.active).length,
  diagnostics: catalog.diagnostics.map((diagnostic) => ({
    collision: diagnostic.collision
      ? {
          loserPath: diagnostic.collision.loserPath,
          name: diagnostic.collision.name,
          resourceType: diagnostic.collision.resourceType,
          winnerPath: diagnostic.collision.winnerPath,
        }
      : null,
    message: diagnostic.message,
    path: diagnostic.path ?? null,
    type: diagnostic.type,
  })),
  invalid: catalog.resources.filter((entry) => !entry.valid).length,
  projectTrusted: catalog.projectTrusted,
  resources: catalog.resources.map((entry) => ({
    active: entry.active,
    filePath: entry.filePath,
    id: entry.id,
    name: entry.name,
    origin: entry.sourceInfo.origin,
    scope: entry.sourceInfo.scope,
    valid: entry.valid,
    writable: entry.writable,
  })),
  total: catalog.resources.length,
});

const summarizeAgents = (catalog: PiAgentCatalogSnapshot) => ({
  agents: catalog.agents.map((agent) => ({
    id: agent.id,
    kind: agent.kind,
    model: agent.model ?? null,
    name: agent.name,
    providerId: agent.providerId,
    source: agent.source,
    status: agent.status,
    thinking: agent.thinking ?? null,
  })),
  diagnostics: catalog.diagnostics,
  projectTrusted: catalog.projectTrusted,
  providers: catalog.providers.map((provider) => ({
    available: provider.available,
    configuration: provider.configuration ?? null,
    id: provider.id,
    label: provider.label,
  })),
});

const summarizeRecovery = (status: RecoveryStatus) => ({
  actions: status.actions,
  available: status.available,
  issues: status.issues,
  modes: status.modes,
  providers: status.providers.map((provider) => ({
    actions: provider.actions,
    active: provider.active,
    bridgeVersion: provider.bridgeVersion ?? null,
    id: provider.id,
    modes: provider.modes,
    name: provider.name,
  })),
});

const summarizeSessionFeatures = (features: PiSessionFeatureState) => ({
  assist: features.assist
    ? {
        evaluationModel: features.assist.evaluationModel ?? null,
        evaluationProvider: features.assist.evaluationProvider ?? null,
        forEntryId: features.assist.forEntryId,
        generatedAt: features.assist.generatedAt,
        suggestionCount: features.assist.suggestions?.length ?? 0,
      }
    : null,
  goal: features.goal
    ? {
        auditFailStreak: features.goal.auditFailStreak,
        blockedStreak: features.goal.blockedStreak,
        createdAt: features.goal.createdAt,
        evaluationModel: features.goal.evaluationModel ?? null,
        evaluationProvider: features.goal.evaluationProvider ?? null,
        id: features.goal.id,
        status: features.goal.status,
        tokenBudget: features.goal.tokenBudget ?? null,
        tokensUsed: features.goal.tokensUsed,
        turnsUsed: features.goal.turnsUsed,
        updatedAt: features.goal.updatedAt,
      }
    : null,
  revision: features.revision,
  schemaVersion: features.schemaVersion,
});

const fetchHealthSnapshot = async () => {
  const endpoint = getRuntimeUrlResolver().health();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await runtimeFetch(endpoint, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    const contentType = response.headers.get('content-type') ?? '';
    const payload = contentType.toLowerCase().includes('json')
      ? await response.json().catch(() => null)
      : null;
    return {
      contentType,
      endpoint: sanitizeRuntimeEndpoint(endpoint),
      httpOk: response.ok,
      httpStatus: response.status,
      snapshot: sanitizeHealthSnapshot(payload),
    };
  } finally {
    clearTimeout(timeout);
  }
};

export const collectVarinDiagnostics = async () => {
  const directoryState = useDirectoryStore.getState();
  const sessionState = usePiSessionStore.getState();
  const projectsState = useProjectsStore.getState();
  const currentSessionId = sessionState.currentSessionId;
  const currentRecord = currentSessionId ? sessionState.records[currentSessionId] : undefined;
  const currentSnapshot = currentRecord?.snapshot;
  const currentDirectory = currentSnapshot?.cwd
    || directoryState.currentDirectory
    || directoryState.homeDirectory
    || '';
  const activeSessionId = currentSessionId && currentRecord?.open ? currentSessionId : null;
  const target: RuntimeContextTarget | null = activeSessionId
    ? { sessionId: activeSessionId }
    : currentDirectory
      ? { cwd: currentDirectory }
      : null;
  const runtimeApis = getRegisteredRuntimeAPIs();

  const [connectionProbe, health, git] = await Promise.all([
    probe(() => getPiRuntimeConnection()),
    probe(fetchHealthSnapshot),
    currentDirectory && runtimeApis
      ? probe(() => runtimeApis.git.checkIsGitRepository(currentDirectory))
      : Promise.resolve(skippedProbe<boolean>(
          currentDirectory ? 'Runtime APIs are unavailable' : 'No active working directory',
        )),
  ]);

  const capabilities = connectionProbe.ok ? connectionProbe.value.handshake.capabilities : null;
  const runtimeClient = connectionProbe.ok ? connectionProbe.value.client : null;
  const missingContext = target === null ? 'No Pi runtime context is available' : null;
  const unavailable = (capability: string): string => (
    connectionProbe.ok
      ? `Pi runtime capability is unavailable: ${capability}`
      : 'Pi runtime connection is unavailable'
  );

  const packagesPromise = capabilities?.packages && target && runtimeClient
    ? probe(async () => summarizePackages(await runtimeClient.request('package.list', target)))
    : Promise.resolve(skippedProbe<ReturnType<typeof summarizePackages>>(
        missingContext ?? unavailable('packages'),
      ));
  const agentsPromise = capabilities?.agentProviders && target && runtimeClient
    ? probe(async () => summarizeAgents(await runtimeClient.request('agentProvider.list', target)))
    : Promise.resolve(skippedProbe<ReturnType<typeof summarizeAgents>>(
        missingContext ?? unavailable('agentProviders'),
      ));
  const skillsPromise = capabilities?.resources && target && runtimeClient
    ? probe(async () => summarizeResources(await runtimeClient.request('resource.list', {
        ...target,
        kind: 'skill',
      })))
    : Promise.resolve(skippedProbe<ReturnType<typeof summarizeResources>>(
        missingContext ?? unavailable('resources'),
      ));
  const recoveryPromise = capabilities?.recovery && activeSessionId && runtimeClient
    ? probe(async () => summarizeRecovery(await runtimeClient.request('recovery.status', {
        sessionId: activeSessionId,
      })))
    : Promise.resolve(skippedProbe<ReturnType<typeof summarizeRecovery>>(
        activeSessionId ? unavailable('recovery') : 'No active Pi session',
      ));

  const [packages, agents, skills, recovery] = await Promise.all([
    packagesPromise,
    agentsPromise,
    skillsPromise,
    recoveryPromise,
  ]);

  const appVersion = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : null;
  const summaries = sessionState.summaries;

  return {
    app: {
      generatedAt: new Date().toISOString(),
      name: 'Varin',
      version: appVersion,
    },
    catalogs: {
      agents,
      packages,
      resources: { skills },
    },
    context: {
      directory: {
        current: currentDirectory || null,
        hasPersistedDirectory: directoryState.hasPersistedDirectory,
        home: directoryState.homeDirectory || null,
        isHomeReady: directoryState.isHomeReady,
        isSwitchingDirectory: directoryState.isSwitchingDirectory,
      },
      projects: {
        activeProjectId: projectsState.activeProjectId,
        projects: projectsState.projects.map((project) => ({
          id: project.id,
          label: project.label,
          path: project.path,
        })),
        total: projectsState.projects.length,
      },
      session: currentSnapshot
        ? {
            busy: currentSnapshot.busy,
            cwd: currentSnapshot.cwd,
            features: summarizeSessionFeatures(currentSnapshot.features),
            id: currentSnapshot.sessionId,
            isCompacting: currentSnapshot.isCompacting,
            isStreaming: currentSnapshot.isStreaming,
            model: currentSnapshot.model ?? null,
            name: currentSnapshot.name ?? null,
            pendingMessageCount: currentSnapshot.pendingMessageCount,
            thinkingLevel: currentSnapshot.thinkingLevel,
          }
        : null,
      sessions: {
        archived: summaries.filter((entry) => Boolean(entry.archivedAt)).length,
        catalogCwd: sessionState.catalogCwd,
        catalogLoaded: sessionState.catalogLoaded,
        open: Object.values(sessionState.records).filter((entry) => entry.open).length,
        persisted: summaries.filter((entry) => entry.persisted).length,
        total: summaries.length,
      },
    },
    integrations: {
      git,
      recovery,
    },
    runtime: {
      connection: connectionProbe.ok
        ? {
            elapsedMs: connectionProbe.elapsedMs,
            handshake: connectionProbe.value.handshake,
            ok: true,
            runtimeKey: sanitizeRuntimeKey(connectionProbe.value.runtimeKey),
          }
        : connectionProbe,
      health,
      surface: runtimeApis?.runtime ?? null,
    },
    userAgent: typeof navigator === 'undefined' ? null : navigator.userAgent,
    windowOrigin: typeof window === 'undefined' ? null : window.location.origin,
  };
};

export const buildVarinDiagnosticsReport = async (): Promise<string> => (
  JSON.stringify(await collectVarinDiagnostics(), null, 2)
);
