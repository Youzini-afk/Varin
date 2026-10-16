import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LanguageServicesError } from '@varin/application-client';
import { getRuntimeEndpointGeneration, switchRuntimeEndpoint } from '@varin/application-client';

const { runtimeFetchMock } = vi.hoisted(() => ({ runtimeFetchMock: vi.fn() }));

vi.mock('@varin/application-client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@varin/application-client')>(),
  runtimeFetch: runtimeFetchMock,
}));

describe('createWebLanguageServicesAPI', () => {
  beforeEach(() => runtimeFetchMock.mockReset());

  it('rejects stale completions after an application-host endpoint switch', async () => {
    const { createWebLanguageServicesAPI } = await import('./language');
    const api = createWebLanguageServicesAPI();
    let resolveResponse: ((value: Response) => void) | undefined;
    runtimeFetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    }));
    const pending = api.hover({
      resource: { workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', resourceId: 'note.ts' },
      languageId: 'typescript',
      documentVersion: 1,
      position: { line: 0, character: 0 },
    });
    switchRuntimeEndpoint({ apiBaseUrl: `https://language-${getRuntimeEndpointGeneration()}.example` });
    resolveResponse?.(Response.json({ status: 'ready', documentVersion: 1, value: 'hover' }));
    await expect(pending).rejects.toBeInstanceOf(LanguageServicesError);
    await expect(pending).rejects.toMatchObject({ reason: 'stale-completion' });
  });

  it('sends generation-bound language commands through the authenticated Host route', async () => {
    runtimeFetchMock.mockResolvedValueOnce(Response.json({
      status: 'ready',
      documentVersion: 3,
      providerId: 'typescript',
      generation: 7,
      value: null,
    }));
    const { createWebLanguageServicesAPI } = await import('./language');
    await createWebLanguageServicesAPI().executeCommand({
      resource: { workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', resourceId: 'note.ts' },
      languageId: 'typescript',
      documentVersion: 3,
      providerId: 'typescript',
      generation: 7,
      command: 'typescript.applyRefactoring',
      arguments: [{ kind: 'fixture' }],
    });
    const [path, options] = runtimeFetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/language/feature');
    expect(JSON.parse(String(options.body))).toMatchObject({
      method: 'executeCommand',
      request: {
        providerId: 'typescript',
        generation: 7,
        command: 'typescript.applyRefactoring',
        arguments: [{ kind: 'fixture' }],
      },
    });
  });

  it('releases an unread rejected language observation instead of retaining its channel', async () => {
    const cancel = vi.fn();
    runtimeFetchMock.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 401 }));
    const { createWebLanguageServicesAPI } = await import('./language');
    const listener = vi.fn();
    const subscription = createWebLanguageServicesAPI().subscribe('workspace', listener);
    await new Promise(resolve => setImmediate(resolve));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(runtimeFetchMock.mock.calls[0]![1].signal.aborted).toBe(true);
    expect(listener).not.toHaveBeenCalled();
    subscription.close();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('releases a language reader when event decoding fails', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start: controller => controller.enqueue(new TextEncoder().encode('data: not-json\n\n')),
      cancel,
    });
    runtimeFetchMock.mockResolvedValueOnce(new Response(body));
    const { createWebLanguageServicesAPI } = await import('./language');
    const listener = vi.fn();
    const subscription = createWebLanguageServicesAPI().subscribe('workspace', listener);
    await new Promise(resolve => setImmediate(resolve));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
    expect(runtimeFetchMock.mock.calls[0]![1].signal.aborted).toBe(true);
    expect(listener).not.toHaveBeenCalled();
    subscription.close();
  });

  it('cancels a late language response after its original subscription was closed', async () => {
    let finish!: (response: Response) => void;
    runtimeFetchMock.mockReturnValueOnce(new Promise<Response>(resolve => { finish = resolve; }));
    const { createWebLanguageServicesAPI } = await import('./language');
    const listener = vi.fn();
    const subscription = createWebLanguageServicesAPI().subscribe('workspace', listener);
    subscription.close();
    const cancel = vi.fn();
    finish(new Response(new ReadableStream<Uint8Array>({ cancel })));
    await new Promise(resolve => setImmediate(resolve));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(listener).not.toHaveBeenCalled();
  });
});
