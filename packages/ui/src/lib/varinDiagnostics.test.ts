import { describe, expect, test, vi } from 'vitest';

const packageTargets: unknown[] = [];
const agentTargets: unknown[] = [];
const resourceTargets: unknown[] = [];

vi.doMock('@/lib/runtime-api/registry', () => ({
  getRegisteredRuntimeAPIs: () => ({
    git: {
      checkIsGitRepository: async () => true,
    },
    runtime: {
      isDesktop: true,
      label: 'Desktop',
      platform: 'desktop',
    },
  }),
}));

vi.doMock('@/lib/pi-runtime/client', () => ({
  getPiRuntimeConnection: async () => ({
    client: {
      request: async (method: string, params: Record<string, unknown>) => {
        const target = typeof params.sessionId === 'string'
          ? { sessionId: params.sessionId }
          : { cwd: String(params.cwd ?? '') };
        switch (method) {
          case 'package.list':
            return (await import('@/lib/pi-runtime/packages')).listPiPackages(target);
          case 'agentProvider.list':
            return (await import('@/lib/pi-runtime/agent-providers')).listPiAgentProviders(target);
          case 'resource.list':
            return (await import('@/lib/pi-runtime/resources')).listPiResources(
              target,
              'skill',
            );
          case 'fleet.status':
            return (await import('@/lib/pi-runtime/fleet')).getPiFleetStatus(String(params.sessionId));
          case 'recovery.status':
            return {
              actions: ['navigate', 'undo'],
              available: true,
              issues: [],
              modes: ['conversation'],
              providers: [{
                actions: ['navigate', 'undo'],
                active: true,
                id: 'pi-native',
                modes: ['conversation'],
                name: 'Pi session tree',
              }],
            };
          default:
            throw new Error(`Unexpected runtime method: ${method}`);
        }
      },
    },
    handshake: {
      capabilities: {
        agentProviders: true,
        extensionUi: true,
        fleet: true,
        models: true,
        packages: true,
        providerConfiguration: true,
        recovery: true,
        resources: true,
        sessionFeatures: true,
        sessions: true,
        settings: true,
      },
      hostVersion: '0.1.0',
      protocolVersion: 1,
      runtime: {
        agentDir: 'C:/Users/test/.pi/agent',
        nodePath: 'C:/Program Files/nodejs/node.exe',
        nodeVersion: '24.0.0',
        piVersion: '0.83.0',
        source: 'bundled',
      },
    },
    runtimeKey: 'url:https://user:secret-token@runtime.example/?varin_url_token=secret-token',
  }),
}));

vi.doMock('@/lib/pi-runtime/packages', () => ({
  listPiPackages: async (target: unknown) => {
    packageTargets.push(target);
    return [{
      enabled: true,
      installed: true,
      name: 'magic-context',
      resolvedPath: 'C:/private/package',
      scope: 'global',
      source: 'https://token:secret-token@example.test/package.git',
      structured: true,
      version: '1.2.3',
    }];
  },
}));

vi.doMock('@/lib/pi-runtime/agent-providers', () => ({
  listPiAgentProviders: async (target: unknown) => {
    agentTargets.push(target);
    return {
      agents: [{
        actions: [],
        description: 'A test agent',
        id: 'magic:historian',
        kind: 'delegatable',
        name: 'Historian',
        providerId: 'magic-context',
        source: { packageName: 'magic-context', scope: 'package' },
        status: 'available',
      }],
      diagnostics: [{
        message: 'Provider warning',
        providerId: 'magic-context',
        severity: 'warning',
      }],
      projectTrusted: true,
      providers: [{
        actions: [],
        available: true,
        description: 'Magic Context',
        id: 'magic-context',
        label: 'Magic Context',
        source: 'https://token:secret-token@example.test/agent-provider.git',
      }],
    };
  },
}));

vi.doMock('@/lib/pi-runtime/resources', () => ({
  listPiResources: async (target: unknown, kind: string) => {
    resourceTargets.push({ kind, target });
    return {
      diagnostics: [{
        collision: {
          loserPath: 'C:/project/.pi/prompts/duplicate.md',
          loserSource: 'https://token:secret-token@example.test/loser.git',
          name: 'example',
          resourceType: kind,
          winnerPath: 'C:/project/.pi/prompts/example.md',
          winnerSource: 'https://token:secret-token@example.test/winner.git',
        },
        message: 'Duplicate resource',
        path: 'C:/project/.pi/prompts/example.md',
        type: 'collision',
      }],
      projectTrusted: true,
      resources: [{
        active: true,
        description: `${kind} description`,
        filePath: `C:/project/.pi/${kind}s/example.md`,
        id: `${kind}:example`,
        kind,
        name: 'example',
        sourceInfo: {
          origin: 'top-level',
          path: `C:/project/.pi/${kind}s/example.md`,
          scope: 'project',
        },
        valid: true,
        writable: true,
      }],
    };
  },
}));

vi.doMock('@/lib/pi-runtime/fleet', () => ({
  getPiFleetStatus: async () => ({
    entries: [{
      actions: [],
      agent: 'Historian',
      description: 'private task contents',
      key: 'agent-1',
      kind: 'delegated-agent',
      name: 'Historian',
      providerId: 'magic-context',
      startedAt: 1,
      state: 'running',
      tokens: { input: 2, output: 3, total: 5 },
    }],
    omitted: 0,
    providers: [{
      id: 'magic-context',
      label: 'Magic Context',
      source: 'https://token:secret-token@example.test/fleet.git',
      state: 'active',
    }],
    totalActive: 1,
  }),
}));

vi.doMock('@varin/application-client', () => ({
  getRuntimeUrlResolver: () => ({
    health: () => 'https://runtime.example/health?varin_url_token=secret-token',
  }),
  runtimeFetch: async () => new Response(JSON.stringify({
    apiOnly: false,
    compatibility: {
      apiVersion: 1,
      capabilities: ['api.health.v1'],
      minClientApiVersion: 1,
    },
    varinVersion: '0.1.0',
    piRuntime: {
      hostVersion: '0.1.0',
      nodeVersion: '24.0.0',
      piVersion: '0.83.0',
      protocolVersion: 1,
      ready: true,
      source: 'bundled',
    },
    providerSecret: 'must-not-be-copied',
    runtime: 'web',
    status: 'ok',
  }), {
    headers: { 'Content-Type': 'application/json' },
    status: 200,
  }),
}));

vi.doMock('@/stores/useDirectoryStore', () => ({
  useDirectoryStore: {
    getState: () => ({
      currentDirectory: 'C:/project',
      hasPersistedDirectory: true,
      homeDirectory: 'C:/Users/test',
      isHomeReady: true,
      isSwitchingDirectory: false,
    }),
  },
}));

vi.doMock('@/stores/usePiSessionStore', () => ({
  usePiSessionStore: {
    getState: () => ({
      catalogCwd: 'C:/project',
      catalogLoaded: true,
      currentSessionId: 'session-1',
      records: {
        'session-1': {
          open: true,
          snapshot: {
            busy: false,
            cwd: 'C:/project',
            features: {
              assist: {
                forEntryId: 'entry-1',
                generatedAt: 1,
                recap: 'private recap contents',
                suggestion: 'private suggestion contents',
              },
              goal: {
                auditFailStreak: 0,
                blockedStreak: 0,
                createdAt: 1,
                id: 'goal-1',
                note: 'private goal note',
                objective: 'private goal objective',
                status: 'active',
                tokenBaseline: 0,
                tokensUsed: 10,
                turnsUsed: 2,
                updatedAt: 2,
              },
              revision: 1,
              schemaVersion: 1,
            },
            isCompacting: false,
            isStreaming: false,
            pendingMessageCount: 0,
            sessionId: 'session-1',
            thinkingLevel: 'medium',
          },
        },
      },
      summaries: [{
        archivedAt: undefined,
        id: 'session-1',
        persisted: true,
      }],
    }),
  },
}));

vi.doMock('@/stores/useProjectsStore', () => ({
  useProjectsStore: {
    getState: () => ({
      activeProjectId: 'project-1',
      projects: [{ id: 'project-1', label: 'Project', path: 'C:/project' }],
    }),
  },
}));

const {
  buildVarinDiagnosticsReport,
  collectVarinDiagnostics,
} = await import('./varinDiagnostics');

describe('Varin diagnostics', () => {
  test('collects Pi-native runtime and plugin summaries for the active session', async () => {
    const report = await collectVarinDiagnostics();

    expect(report.runtime.connection.ok).toBe(true);
    expect(report.runtime.health.ok).toBe(true);
    expect(report.context.session?.id).toBe('session-1');
    expect(report.catalogs.packages.ok && report.catalogs.packages.value.total).toBe(1);
    expect(report.catalogs.agents.ok && report.catalogs.agents.value.providers[0]?.id).toBe('magic-context');
    expect(report.integrations.fleet.ok && report.integrations.fleet.value.totalActive).toBe(1);
    expect(report.integrations.recovery.ok && report.integrations.recovery.value.available).toBe(true);
    expect(packageTargets).toEqual([{ sessionId: 'session-1' }]);
    expect(agentTargets).toEqual([{ sessionId: 'session-1' }]);
    expect(resourceTargets).toEqual([
      { kind: 'skill', target: { sessionId: 'session-1' } },
    ]);
  });

  test('keeps credentials, raw plugin sources, fleet goals, and unknown health fields out of the report', async () => {
    const report = await buildVarinDiagnosticsReport();

    expect(report).toContain('https://runtime.example/health');
    expect(report).toContain('magic-context');
    expect(report).not.toContain('secret-token');
    expect(report).not.toContain('must-not-be-copied');
    expect(report).not.toContain('private task contents');
    expect(report).not.toContain('private recap contents');
    expect(report).not.toContain('private suggestion contents');
    expect(report).not.toContain('private goal note');
    expect(report).not.toContain('private goal objective');
    expect(report).not.toContain('resolvedPath');
    expect(report).not.toContain('providerSecret');
  });
});
