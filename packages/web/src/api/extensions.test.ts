import { afterEach, describe, expect, it, vi } from 'vitest';

const refreshLocalRuntimeUrlAuthToken = vi.fn();
const fetchWithoutRuntimeRouting = vi.fn();

vi.mock('@varin/application-client', () => ({
  fetchWithoutRuntimeRouting,
  refreshLocalRuntimeUrlAuthToken,
}));

const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

afterEach(() => {
  vi.restoreAllMocks();
  refreshLocalRuntimeUrlAuthToken.mockReset();
  fetchWithoutRuntimeRouting.mockReset();
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

describe('createWebExtensionsAPI', () => {
  it('reads from the application host instead of the selected Pi runtime', async () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        __VARIN_API_BASE_URL__: 'https://remote-pi.example',
        __VARIN_LOCAL_ORIGIN__: 'http://127.0.0.1:57123',
        location: { href: 'varin-ui://app/', origin: 'varin-ui://app' },
      },
    });
    refreshLocalRuntimeUrlAuthToken.mockResolvedValue('local-url-token');
    fetchWithoutRuntimeRouting.mockResolvedValue(Response.json({
      supported: true,
      status: 'ready',
      snapshot: {
        schemaVersion: 1,
        hostId: '2d7b1dc1-7ccd-4be7-9fd1-23f31dc8cf1a',
        revision: 0,
        loadedAt: '2026-08-14T00:00:00.000Z',
        authoritative: true,
        storageState: 'missing',
        diagnostics: [],
        extensions: [],
      },
    }));

    const { createWebExtensionsAPI } = await import('./extensions');
    const result = await createWebExtensionsAPI().catalog();

    expect(result.supported).toBe(true);
    expect(refreshLocalRuntimeUrlAuthToken).toHaveBeenCalledWith('http://127.0.0.1:57123');
    const target = new URL(String(fetchWithoutRuntimeRouting.mock.calls[0]?.[0]));
    expect(target.origin).toBe('http://127.0.0.1:57123');
    expect(target.pathname).toBe('/api/varin/extensions/v1/catalog');
    expect(target.searchParams.get('varin_url_token')).toBe('local-url-token');
  });

  it('rejects a malformed contract response through the shared decoder', async () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { location: { href: 'https://host.example/', origin: 'https://host.example' } },
    });
    fetchWithoutRuntimeRouting.mockResolvedValue(Response.json({ action: 'list', kind: 'service', entries: [] }));
    const { createWebExtensionsAPI } = await import('./extensions');
    await expect(createWebExtensionsAPI().queryContracts({ action: 'list', kind: 'service' })).rejects.toThrow();
  });

  it('reloads a local source by stored extension identity without sending a source specifier', async () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        __VARIN_LOCAL_ORIGIN__: 'http://127.0.0.1:57123',
        location: { href: 'varin-ui://app/', origin: 'varin-ui://app' },
      },
    });
    refreshLocalRuntimeUrlAuthToken.mockResolvedValue('local-url-token');
    fetchWithoutRuntimeRouting.mockResolvedValue(Response.json({
      outcome: 'unchanged',
      snapshot: {
        schemaVersion: 1,
        hostId: '2d7b1dc1-7ccd-4be7-9fd1-23f31dc8cf1a',
        revision: 7,
        loadedAt: '2026-08-14T00:00:00.000Z',
        authoritative: true,
        storageState: 'ready',
        diagnostics: [],
        extensions: [],
      },
    }));

    const { createWebExtensionsAPI } = await import('./extensions');
    const result = await createWebExtensionsAPI().reloadLocalSource({
      expectedRevision: 7,
      extensionId: 'dev.example.local',
    });

    expect(result.outcome).toBe('unchanged');
    const [target, init] = fetchWithoutRuntimeRouting.mock.calls[0] as [URL, RequestInit];
    expect(target.pathname).toBe('/api/varin/extensions/v1/extensions/dev.example.local/reload-local-source');
    expect(JSON.parse(String(init.body))).toEqual({
      expectedRevision: 7,
      extensionId: 'dev.example.local',
    });
    expect(String(init.body)).not.toContain('specifier');
  });

  it('sends the explicit extension-data choice when removing an extension', async () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        __VARIN_LOCAL_ORIGIN__: 'http://127.0.0.1:57123',
        location: { href: 'varin-ui://app/', origin: 'varin-ui://app' },
      },
    });
    refreshLocalRuntimeUrlAuthToken.mockResolvedValue('local-url-token');
    fetchWithoutRuntimeRouting.mockResolvedValue(Response.json({
      snapshot: {
        schemaVersion: 1,
        hostId: '2d7b1dc1-7ccd-4be7-9fd1-23f31dc8cf1a',
        revision: 8,
        loadedAt: '2026-08-14T00:00:00.000Z',
        authoritative: true,
        storageState: 'ready',
        diagnostics: [],
        extensions: [],
      },
    }));

    const { createWebExtensionsAPI } = await import('./extensions');
    await createWebExtensionsAPI().removeExtension({
      deleteData: true,
      expectedRevision: 7,
      extensionId: 'dev.example.local',
    });

    const [target, init] = fetchWithoutRuntimeRouting.mock.calls[0] as [URL, RequestInit];
    expect(target.pathname).toBe('/api/varin/extensions/v1/extensions/dev.example.local');
    expect(init.method).toBe('DELETE');
    expect(JSON.parse(String(init.body))).toEqual({
      deleteData: true,
      expectedRevision: 7,
      extensionId: 'dev.example.local',
    });
  });
});

describe('Surface composition lease stream', () => {
  const request = {
    owner: { hostId: '2d7b1dc1-7ccd-4be7-9fd1-23f31dc8cf1a', realmId: 'window-test', extensionId: 'dev.example.consumer',
      extensionVersion: '1.0.0', entrypointId: 'main', generation: 1, desiredRevision: 1 },
    surface: 'web' as const, artifactIntegrity: 'sha256-lease', slot: 'selected' as const,
    expectedRoutingRevision: 7, routing: { threadId: 'thread-p' }, services: [],
  };
  const setup = () => Object.defineProperty(globalThis, 'window', { configurable: true,
    value: { __VARIN_LOCAL_ORIGIN__: 'http://127.0.0.1:57123', location: { href: 'varin-ui://app/', origin: 'varin-ui://app' } } });

  it('holds one authenticated POST until EOF, parsing fragmented UTF-8 SSE events without renewing', async () => {
    setup();
    refreshLocalRuntimeUrlAuthToken.mockResolvedValue('application-token');
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const cancelled = vi.fn();
    fetchWithoutRuntimeRouting.mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; }, cancel: cancelled }),
      { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } }));
    const { createWebExtensionsAPI } = await import('./extensions');
    const events: unknown[] = [];
    let finished = false;
    const watching = createWebExtensionsAPI().watchServiceLease(request, event => { events.push(event); }, new AbortController().signal).then(() => { finished = true; });
    await vi.waitFor(() => expect(fetchWithoutRuntimeRouting).toHaveBeenCalledTimes(1));
    const encoder = new TextEncoder();
    const bytes = encoder.encode('data: {"kind":"ready","leaseId":"lease-p","routingRevision":7,"providers":[]}\r\n\r\ndata: {"kind":"error","message":"连接断开"}\n\n');
    for (const byte of bytes) stream.enqueue(Uint8Array.of(byte));
    await vi.waitFor(() => expect(events).toHaveLength(2));
    expect(finished).toBe(false);
    const [url, init] = fetchWithoutRuntimeRouting.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe('/api/varin/extensions/v1/services/lease');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect(new Headers(init.headers).get('X-Varin-Application-Token')).toBe('application-token');
    expect(new Headers(init.headers).get('Accept')).toBe('text/event-stream');
    expect(JSON.parse(String(init.body))).toEqual(request);
    expect(events[1]).toEqual({ kind: 'error', message: '连接断开' });
    stream.close();
    await watching;
    expect(fetchWithoutRuntimeRouting).toHaveBeenCalledTimes(1);
  });

  it('cancels a blocked reader and keeps the original invocation routing and AbortSignal', async () => {
    setup();
    refreshLocalRuntimeUrlAuthToken.mockResolvedValue('application-token');
    const cancelled = vi.fn();
    fetchWithoutRuntimeRouting.mockResolvedValueOnce(new Response(new ReadableStream({ cancel: cancelled }), { headers: { 'Content-Type': 'text/event-stream' } }));
    const { createWebExtensionsAPI } = await import('./extensions');
    const controller = new AbortController();
    const watching = createWebExtensionsAPI().watchServiceLease(request, () => undefined, controller.signal);
    const failed = expect(watching).rejects.toThrow('owner closed');
    await vi.waitFor(() => expect(fetchWithoutRuntimeRouting).toHaveBeenCalledTimes(1));
    controller.abort(new Error('owner closed'));
    await failed;
    expect(cancelled).toHaveBeenCalledTimes(1);
    fetchWithoutRuntimeRouting.mockResolvedValueOnce(Response.json({ result: 'p' }));
    const callController = new AbortController();
    const invocation = { args: [], method: 'read', serviceId: 'dev.example.service', version: 1, providerId: 'instance-p',
      routing: request.routing, lease: { id: 'lease-p', owner: { realmId: 'window-test', extensionId: 'dev.example.consumer', entrypointId: 'main', generation: 1 } } };
    await expect(createWebExtensionsAPI().invokeService(invocation, callController.signal)).resolves.toBe('p');
    const init = fetchWithoutRuntimeRouting.mock.calls[1]?.[1] as RequestInit;
    expect(init.signal).toBe(callController.signal);
    expect(JSON.parse(String(init.body))).toEqual(invocation);
  });

  it('releases a non-SSE lease response before rejecting it', async () => {
    setup();
    refreshLocalRuntimeUrlAuthToken.mockResolvedValue('application-token');
    const cancelled = vi.fn();
    fetchWithoutRuntimeRouting.mockResolvedValueOnce(new Response(new ReadableStream({ cancel: cancelled }), {
      headers: { 'Content-Type': 'text/html' },
    }));
    const { createWebExtensionsAPI } = await import('./extensions');
    await expect(createWebExtensionsAPI().watchServiceLease(request, () => undefined, new AbortController().signal))
      .rejects.toThrow('not an event stream');
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(fetchWithoutRuntimeRouting).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed lease events and cancels the stream', async () => {
    setup();
    refreshLocalRuntimeUrlAuthToken.mockResolvedValue('application-token');
    const cancelled = vi.fn();
    fetchWithoutRuntimeRouting.mockResolvedValue(new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('data: {"kind":"ready","leaseId":"missing-provider-fields"}\n\n')); }, cancel: cancelled,
    }), { headers: { 'Content-Type': 'text/event-stream' } }));
    const { createWebExtensionsAPI } = await import('./extensions');
    await expect(createWebExtensionsAPI().watchServiceLease(request, () => undefined, new AbortController().signal)).rejects.toThrow();
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(fetchWithoutRuntimeRouting).toHaveBeenCalledTimes(1);
  });
});
