import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RunServicesError } from '@varin/application-client';
import { getRuntimeEndpointGeneration, switchRuntimeEndpoint } from '@varin/application-client';
import { installRuntimeEndpointFetchFixture } from '../../test/runtime-endpoint.fixture.js';

installRuntimeEndpointFetchFixture();

const { runtimeFetchMock } = vi.hoisted(() => ({ runtimeFetchMock: vi.fn() }));

vi.mock('@varin/application-client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@varin/application-client')>(),
  runtimeFetch: runtimeFetchMock,
}));

describe('createWebWorkspaceDebugAPI', () => {
  beforeEach(() => {
    runtimeFetchMock.mockReset();
  });

  it('forwards the expected debug owner with breakpoint mutations', async () => {
    const { createWebWorkspaceDebugAPI } = await import('./debug');
    const api = createWebWorkspaceDebugAPI();
    runtimeFetchMock.mockResolvedValueOnce(Response.json({
      status: 'stale',
      workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      sessionId: 'debug-2',
      generation: 2,
      breakpoints: [{ resourceId: 'src/file.ts', line: 3 }],
    }));
    await expect(api.setBreakpoints({
      workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      resourceId: 'src/file.ts',
      lines: [7],
      expectedSessionId: 'debug-1',
      expectedGeneration: 1,
    })).resolves.toMatchObject({ status: 'stale', sessionId: 'debug-2', generation: 2 });
    expect(runtimeFetchMock).toHaveBeenCalledWith('/api/debug/breakpoints', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        resourceId: 'src/file.ts',
        lines: [7],
        expectedSessionId: 'debug-1',
        expectedGeneration: 1,
      }),
    }));
  });

  it('rejects stale completions after an application-host endpoint switch', async () => {
    const { createWebWorkspaceDebugAPI } = await import('./debug');
    const api = createWebWorkspaceDebugAPI();
    let resolveResponse: ((value: Response) => void) | undefined;
    runtimeFetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    }));
    const pending = api.getStatus('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    switchRuntimeEndpoint({ apiBaseUrl: `https://debug-${getRuntimeEndpointGeneration()}.example` });
    resolveResponse?.(Response.json({ status: 'paused', workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }));
    await expect(pending).rejects.toBeInstanceOf(RunServicesError);
    await expect(pending).rejects.toMatchObject({ reason: 'stale-completion' });
  });
});
