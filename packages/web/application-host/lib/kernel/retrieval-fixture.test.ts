import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';

const resources = vi.hoisted(() => ({
  getKernel: vi.fn(), disposeRuntime: vi.fn(), disposeCompute: vi.fn(), cleanupDocuments: vi.fn(),
  middleware: vi.fn(), servers: [] as Server[],
}));
vi.mock('node:http', async (original) => {
  const http = await original<typeof import('node:http')>();
  return { ...http, createServer: (...args: Parameters<typeof http.createServer>) => {
    const server = http.createServer(...args); resources.servers.push(server); return server;
  } };
});
vi.mock('express', () => ({ default: () => ({}) }));
vi.mock('../documents/contract-fixtures.js', () => ({ createDocumentAuthorityHarness: async () => ({
  authority: {}, identity: { workspaceId: 'fixture' }, cleanup: resources.cleanupDocuments,
}) }));
vi.mock('../process/native-process.test-helper.js', () => ({ createNativeProcessTestHarness: () => ({
  get: resources.getKernel, dispose: resources.disposeRuntime,
}) }));
vi.mock('./compute-service.js', () => ({ createKernelComputeService: () => ({ dispose: resources.disposeCompute }) }));
vi.mock('./live-source.js', () => ({ createLiveSourceOwner: () => ({}) }));
vi.mock('./agent-runtime-client.js', () => ({ AgentRuntimeClient: class {} }));
vi.mock('./credential-owner.js', () => ({ ExistingHostCredentialOwner: class {} }));
vi.mock('./thread-adapter.js', () => ({ ThreadAdapter: class {} }));
vi.mock('./thread-routes.js', () => ({ registerThreadRoutes: vi.fn() }));
vi.mock('../platform/core-routes.js', () => ({ registerCommonRequestMiddleware: resources.middleware }));

vi.stubEnv('VARIN_TEST_KERNEL_PATH', process.execPath);
const { retrievalFixture } = await import('./retrieval-review.test-helper.js');
afterAll(() => vi.unstubAllEnvs());
beforeEach(() => {
  vi.resetAllMocks();
  resources.servers.length = 0;
  resources.getKernel.mockResolvedValue({ client: {} });
});

it('rolls back Documents when the kernel fixture cannot initialize', async () => {
  const failure = new Error('kernel startup failed');
  resources.getKernel.mockRejectedValue(failure);
  await expect(retrievalFixture(() => {})).rejects.toBe(failure);
  expect(resources.disposeRuntime).toHaveBeenCalledOnce();
  expect(resources.cleanupDocuments).toHaveBeenCalledOnce();
  expect(resources.servers).toHaveLength(0);
});

it('closes the actual model listener after later setup fails, continuing past a failed cleanup', async () => {
  const setupFailure = new Error('route setup failed');
  const cleanupFailure = new Error('compute release failed');
  resources.middleware.mockImplementation(() => { throw setupFailure; });
  resources.disposeCompute.mockRejectedValue(cleanupFailure);
  try {
    const pending = retrievalFixture(() => {});
    await expect(pending).rejects.toBeInstanceOf(AggregateError);
    await expect(pending).rejects.toMatchObject({ errors: [setupFailure, { errors: [cleanupFailure] }] });
    expect(resources.servers).toHaveLength(1);
    expect(resources.servers[0]!.listening).toBe(false);
    expect(resources.disposeRuntime).toHaveBeenCalledOnce();
    expect(resources.cleanupDocuments).toHaveBeenCalledOnce();
  } finally {
    // Keep this test bounded if fixture rollback regresses.
    for (const server of resources.servers) {
      server.closeAllConnections();
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }
});
