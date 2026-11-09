import { describe, expect, it, vi } from 'vitest';
import { WorkspaceSearchError } from '@varin/application-client';
import { getRuntimeEndpointGeneration, switchRuntimeEndpoint } from '@varin/application-client';
import { installRuntimeEndpointFetchFixture } from '../../test/runtime-endpoint.fixture.js';

installRuntimeEndpointFetchFixture();

const { runtimeFetchMock } = vi.hoisted(() => ({ runtimeFetchMock: vi.fn() }));

vi.mock('@varin/application-client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@varin/application-client')>(),
  runtimeFetch: runtimeFetchMock,
}));

describe('createWebWorkspaceSearchAPI', () => {
  it('returns a discriminated failure instead of empty hits', async () => {
    const { createWebWorkspaceSearchAPI } = await import('./workspace-search');
    const api = createWebWorkspaceSearchAPI();
    runtimeFetchMock.mockResolvedValueOnce(Response.json({
      status: 'failure',
      generation: 1,
      message: 'ripgrep is unavailable',
    }));
    await expect(api.searchContent({ workspaceId: 'ws', query: 'todo' })).resolves.toEqual({
      status: 'failure',
      generation: 1,
      message: 'ripgrep is unavailable',
    });
  });

  it('rejects stale completions after an application-host endpoint switch', async () => {
    const { createWebWorkspaceSearchAPI } = await import('./workspace-search');
    const api = createWebWorkspaceSearchAPI();
    let resolveResponse: ((value: Response) => void) | undefined;
    runtimeFetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    }));
    const pending = api.searchContent({ workspaceId: 'ws', query: 'todo' });
    switchRuntimeEndpoint({ apiBaseUrl: `https://search-${getRuntimeEndpointGeneration()}.example` });
    resolveResponse?.(Response.json({ status: 'empty', generation: 0 }));
    await expect(pending).rejects.toBeInstanceOf(WorkspaceSearchError);
    await expect(pending).rejects.toMatchObject({ reason: 'stale-completion' });
  });

  it('treats abort as cancelled rather than empty', async () => {
    const { createWebWorkspaceSearchAPI } = await import('./workspace-search');
    const api = createWebWorkspaceSearchAPI();
    const controller = new AbortController();
    runtimeFetchMock.mockImplementationOnce(() => {
      controller.abort();
      const error = new Error('aborted');
      error.name = 'AbortError';
      return Promise.reject(error);
    });
    await expect(api.searchContent({ workspaceId: 'ws', query: 'todo' }, { signal: controller.signal })).resolves.toEqual({
      status: 'cancelled',
      generation: getRuntimeEndpointGeneration(),
    });
  });

  it('reports streamed batches before returning the complete ready result', async () => {
    const { createWebWorkspaceSearchAPI } = await import('./workspace-search');
    const generation = getRuntimeEndpointGeneration();
    const hit = {
      resource: { workspaceId: 'ws', resourceId: 'note.ts' },
      line: 2,
      column: 1,
      preview: 'todo',
    };
    runtimeFetchMock.mockResolvedValueOnce(new Response([
      JSON.stringify({ type: 'batch', hits: [hit] }),
      JSON.stringify({ type: 'result', result: { status: 'ready', generation } }),
      '',
    ].join('\n'), { headers: { 'content-type': 'application/x-ndjson' } }));
    const batches: unknown[] = [];
    await expect(createWebWorkspaceSearchAPI().searchContent(
      { workspaceId: 'ws', query: 'todo' },
      { onBatch: (items) => batches.push(items) },
    )).resolves.toEqual({ status: 'ready', generation, hits: [hit] });
    expect(batches).toEqual([[hit]]);
  });
});
