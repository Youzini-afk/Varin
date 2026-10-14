import { beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ generation: 1, read: vi.fn(), health: vi.fn() }));
vi.mock('@varin/application-client', () => ({
  getRuntimeEndpointGeneration: () => fixture.generation,
  getRuntimeUrlResolver: () => ({ health: () => 'https://user:credential@host.test/health?token=credential' }),
  runtimeFetch: (...args: unknown[]) => fixture.health(...args),
}));
vi.mock('@/lib/runtime-api/registry', () => ({ getRegisteredRuntimeAPIs: () => ({
  threads: { snapshot: (...args: unknown[]) => fixture.read(...args) },
  git: { checkIsGitRepository: async () => true }, runtime: { platform: 'web' },
}) }));
vi.mock('@/stores/useThreadStore', () => ({ useThreadStore: { getState: () => ({
  selectedIdentity: { runtime: 'agent', threadId: 't', branchId: 'b' }, catalogLoaded: true, catalogLoading: false,
  catalogError: null, threads: [{ thread_id: 't', archived: false }],
}) } }));
vi.mock('@/stores/useModelCatalogStore', () => ({ useModelCatalogStore: { getState: () => ({
  loaded: true, loading: false, error: null, channels: [{ id: 'channel', type: 'openai', enabled: true,
    authentication: { apiKey: 'credential' }, models: [{ id: 'model', enabled: true, operations: ['chat'] }] }],
}) } }));
vi.mock('@/stores/useDirectoryStore', () => ({ useDirectoryStore: { getState: () => ({ currentDirectory: '/workspace' }) } }));
vi.mock('@/stores/useProjectsStore', () => ({ useProjectsStore: { getState: () => ({ activeProjectId: 'project', projects: [{}] }) } }));
import { collectVarinDiagnostics } from './varinDiagnostics';
const snapshot = () => ({ identity: { runtime: 'agent', threadId: 't', branchId: 'b' }, thread: { revision: 3 }, eventCursor: 8,
  activeRun: { id: 'run', state: 'waiting', epoch: 1, cancel_requested: false }, history: [{ content: 'private prompt' }], inputs: [],
  operations: [{ id: 'op', intent: 'tool', phase: 'executing', cancel_requested: false, arguments: 'private prompt' }],
  recovery: { operations: [] },
});
beforeEach(() => { fixture.generation = 1; fixture.read.mockReset(); fixture.read.mockResolvedValue(snapshot());
  fixture.health.mockReset(); fixture.health.mockResolvedValue(Response.json({ status: 'ready', runtime: 'web', providerAuth: 'credential' })); });
describe('native diagnostics', () => {
  it('reads the selected real Thread and reports metadata without auth or content', async () => {
    const result = await collectVarinDiagnostics();
    expect(fixture.read).toHaveBeenCalledWith({ runtime: 'agent', threadId: 't', branchId: 'b' });
    expect(result.context.selectedThread).toMatchObject({ ok: true, value: { eventCursor: 8, historyLoaded: 1, activeRun: { id: 'run' } } });
    const encoded = JSON.stringify(result);
    expect(encoded).not.toContain('private prompt'); expect(encoded).not.toContain('credential');
    expect(encoded).toContain('https://host.test/health');
  });
  it('rejects a mixed-Host report even when native IDs collide', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    fixture.read.mockImplementation(async () => { await gate; return snapshot(); });
    const pending = collectVarinDiagnostics(); fixture.generation++; release();
    await expect(pending).rejects.toThrow('Application Host changed');
  });
});
