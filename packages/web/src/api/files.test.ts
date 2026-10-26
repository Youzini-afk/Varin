import { afterEach, describe, expect, it, vi } from 'vitest';

import { isFilesystemError, type RuntimeUrlQuery, type RuntimeUrlResolver } from '@varin/application-client';

const { runtimeFetchMock, generation } = vi.hoisted(() => ({ runtimeFetchMock: vi.fn(), generation: { value: 0 } }));

vi.mock('@varin/application-client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@varin/application-client')>(),
  runtimeFetch: runtimeFetchMock,
  getRuntimeEndpointGeneration: () => generation.value,
}));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const toUrl = (path: string, query?: RuntimeUrlQuery): string => {
  const params = query instanceof URLSearchParams ? query : new URLSearchParams();
  const queryString = params.toString();
  return queryString ? `${path}?${queryString}` : path;
};

const urls: RuntimeUrlResolver = {
  api: toUrl,
  authenticatedAsset: toUrl,
  auth: toUrl,
  health: (query?: RuntimeUrlQuery) => toUrl('/health', query),
  rawFile: (path: string) => toUrl('/api/fs/raw', new URLSearchParams({ path })),
  sse: toUrl,
  websocket: toUrl,
};

describe('createWebFilesAPI', () => {
  it('resolves the active runtime home directory', async () => {
    const { createWebFilesAPI } = await import('./files');
    const api = createWebFilesAPI({ urls, getDirectory: () => '/current-workspace' });

    runtimeFetchMock.mockResolvedValueOnce(Response.json({ home: 'C:\\Users\\Pi' }));

    await expect(api.getHomeDirectory()).resolves.toBe('C:/Users/Pi');
    expect(runtimeFetchMock).toHaveBeenLastCalledWith('/api/fs/home', {
      headers: { Accept: 'application/json' },
    });
  });

  it('lists directories through the Varin files endpoint', async () => {
    const { createWebFilesAPI } = await import('./files');
    const api = createWebFilesAPI({ urls, getDirectory: () => '/current-workspace' });

    runtimeFetchMock.mockResolvedValueOnce(Response.json({
      path: '/current-workspace',
      entries: [
        { name: 'src', path: '/current-workspace/src', isDirectory: true },
        { name: 'README.md', path: '/current-workspace/README.md', isDirectory: false },
      ],
    }));

    await expect(api.listDirectory('/current-workspace', { respectGitignore: true })).resolves.toEqual({
      directory: '/current-workspace',
      entries: [
        { name: 'src', path: '/current-workspace/src', isDirectory: true },
        { name: 'README.md', path: '/current-workspace/README.md', isDirectory: false },
      ],
    });
    expect(runtimeFetchMock).toHaveBeenLastCalledWith('/api/fs/list', {
      query: new URLSearchParams({ path: '/current-workspace', respectGitignore: 'true' }),
      headers: { 'x-varin-directory': '/current-workspace' },
    });
  });

  it.each([
    { reason: 'os-permission', status: 403, expected: 'os-permission' },
    { reason: 'not-directory', status: 400, expected: 'not-directory' },
    { reason: 'future-host-reason', status: 503, expected: 'unknown' },
  ])('preserves $reason failures through the actual files client', async ({ reason, status, expected }) => {
    const { createWebFilesAPI } = await import('./files');
    const api = createWebFilesAPI({ urls, getDirectory: () => '/current-workspace' });
    runtimeFetchMock.mockResolvedValueOnce(Response.json(
      { error: 'Directory is unavailable', reason }, { status },
    ));

    const pending = api.listDirectory('/restricted');
    await expect(pending).rejects.toSatisfy(isFilesystemError);
    await expect(pending).rejects.toMatchObject({ reason: expected, status });
  });

  it('opts into outside-workspace directory creation for project onboarding', async () => {
    const { createWebFilesAPI } = await import('./files');
    const api = createWebFilesAPI({ urls, getDirectory: () => '/current-workspace' });

    runtimeFetchMock.mockResolvedValueOnce(Response.json({ success: true, path: '/projects/new-app' }));

    await expect(api.createDirectory('/projects/new-app', { allowOutsideWorkspace: true })).resolves.toEqual({
      success: true,
      path: '/projects/new-app',
    });
    expect(runtimeFetchMock).toHaveBeenLastCalledWith('/api/fs/mkdir', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-varin-directory': '/current-workspace',
      },
      body: JSON.stringify({ path: '/projects/new-app', allowOutsideWorkspace: true }),
    });
  });

  it('uses per-call workspace directory for stat requests', async () => {
    const { createWebFilesAPI } = await import('./files');
    const api = createWebFilesAPI({ urls, getDirectory: () => '/stale-workspace' });

    runtimeFetchMock.mockResolvedValueOnce(Response.json({ path: '/worktree-b/file.txt', isFile: true, size: 12 }));
    await api.statFile?.('/worktree-b/file.txt', { directory: '/worktree-a' });

    expect(runtimeFetchMock).toHaveBeenLastCalledWith('/api/fs/stat', {
      query: new URLSearchParams({ path: '/worktree-b/file.txt' }),
      headers: { 'x-varin-directory': '/worktree-a' },
    });
  });

  it('sends the workspace directory header for downloads', async () => {
    const { createWebFilesAPI } = await import('./files');
    const api = createWebFilesAPI({ urls, getDirectory: () => '/current-workspace' });

    runtimeFetchMock.mockResolvedValueOnce(new Response('', { status: 500 }));
    await expect(api.downloadFile?.('/current-workspace/file.txt')).rejects.toThrow('Download failed');

    expect(runtimeFetchMock).toHaveBeenLastCalledWith('/api/fs/raw', {
      query: { path: '/current-workspace/file.txt', download: true },
      headers: { 'x-varin-directory': '/current-workspace' },
    });
  });

  it('downloads original binary bytes from the captured directory and drops a stale Host response', async () => {
    const { createWebFilesAPI } = await import('./files');
    const api = createWebFilesAPI({ urls, getDirectory: () => '/unrelated-project' });
    vi.useFakeTimers();
    const anchor = { href: '', download: '', click: vi.fn() };
    vi.stubGlobal('document', { createElement: () => anchor, body: { appendChild: vi.fn(), removeChild: vi.fn() } });
    const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:download');
    const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const bytes = new Uint8Array([0, 255, 0x50, 0x4b, 128, 13, 10]);
    runtimeFetchMock.mockResolvedValueOnce(new Response(bytes));
    await api.downloadFile?.('/retained-source/report.xlsx', { directory: '/retained-source' });
    expect(runtimeFetchMock).toHaveBeenLastCalledWith('/api/fs/raw', {
      query: { path: '/retained-source/report.xlsx', download: true },
      headers: { 'x-varin-directory': '/retained-source' },
    });
    expect(new Uint8Array(await (createUrl.mock.calls[0]![0] as Blob).arrayBuffer())).toEqual(bytes);
    expect(anchor.download).toBe('report.xlsx'); expect(anchor.click).toHaveBeenCalledOnce();
    await vi.runAllTimersAsync(); expect(revokeUrl).toHaveBeenCalledWith('blob:download');

    let finishResponse!: (response: Response) => void;
    runtimeFetchMock.mockReturnValueOnce(new Promise<Response>(resolve => { finishResponse = resolve; }));
    const download = api.downloadFile!('/retained-source/report.xlsx', { directory: '/retained-source' });
    generation.value++;
    finishResponse(new Response(bytes));
    await expect(download).rejects.toMatchObject({ name: 'AbortError' });
    expect(anchor.click).toHaveBeenCalledOnce();
  });
});
