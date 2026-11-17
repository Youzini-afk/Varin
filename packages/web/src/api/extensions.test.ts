import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLocalRuntimeAuthCredentialProvider, switchRuntimeEndpoint } from '@varin/application-client';

const { fetchWithoutRuntimeRouting } = vi.hoisted(() => ({ fetchWithoutRuntimeRouting: vi.fn() }));

vi.mock('@varin/application-client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@varin/application-client')>(),
  fetchWithoutRuntimeRouting,
}));

const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

beforeEach(() => {
  setLocalRuntimeAuthCredentialProvider('http://127.0.0.1:57123', async () => ({ type: 'bearer', token: 'local-desktop-token' }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setLocalRuntimeAuthCredentialProvider(null, null);
  fetchWithoutRuntimeRouting.mockReset();
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

describe('native mobile workbench', () => {
  const firstHost = 'https://first.example';
  const secondHost = 'https://second.example';
  const hostId = '2d7b1dc1-7ccd-4be7-9fd1-23f31dc8cf1a';
  const date = '2026-08-14T00:00:00.000Z';
  const storage = { authoritative: true, diagnostics: [], hostId, storageState: 'missing' };
  const snapshot = {
    catalog: { ...storage, schemaVersion: 1, revision: 1, loadedAt: date, extensions: [] },
    revision: 1,
    routing: { ...storage, document: { revision: 0, rules: [], schemaVersion: 1, updatedAt: date } },
    services: { hostId, providers: [], revision: 0 },
    workbench: { ...storage, document: {
      activeProfileId: 'default', layouts: [], profileSelections: { users: {} },
      profiles: [{ id: 'default', label: 'Default' }], revision: 0, schemaVersion: 1, updatedAt: date,
    } },
  };
  const fetch = vi.fn<typeof globalThis.fetch>();

  beforeEach(() => {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(new EventTarget(), {
      Capacitor: { isNativePlatform: () => true },
      location: new URL('https://localhost/'),
    }) });
    fetch.mockReset();
    fetch.mockImplementation(async (input) => {
      if (String(input).endsWith('/url-token')) return Response.json({});
      return Response.json(String(input).endsWith('/profile/select') ? snapshot.workbench : snapshot);
    });
    vi.stubGlobal('fetch', fetch);
  });

  afterEach(() => {
    switchRuntimeEndpoint({ apiBaseUrl: '' });
  });

  it('waits for a connection before requesting the catalog', async () => {
    const { createWebExtensionsAPI } = await import('./extensions');
    await expect(createWebExtensionsAPI().hostState()).rejects.toThrow('Connect to a Varin Host');
    expect(fetch).not.toHaveBeenCalled();
    expect(fetchWithoutRuntimeRouting).not.toHaveBeenCalled();
  });

  it('uses the connected Host and its auth for workbench state and selection', async () => {
    switchRuntimeEndpoint({ apiBaseUrl: firstHost, clientToken: 'first-host-token' });
    const { createWebExtensionsAPI } = await import('./extensions');
    const api = createWebExtensionsAPI();
    const selection = { profileId: 'default', scope: 'user' as const, scopeId: 'default', expectedRevision: 0, surface: 'mobile' as const };
    await expect(api.hostState()).resolves.toMatchObject({ catalog: { hostId } });
    await expect(api.selectWorkbenchProfile(selection)).resolves.toMatchObject({ hostId });

    const requests = fetch.mock.calls.filter(([url]) => String(url).includes('/extensions/'));
    expect(requests.map(([url, init]) => [String(url), init?.method, new Headers(init?.headers).get('Authorization')])).toEqual([
      [`${firstHost}/api/varin/extensions/v1/host-state`, undefined, 'Bearer first-host-token'],
      [`${firstHost}/api/varin/extensions/v1/workbench/profile/select`, 'PATCH', 'Bearer first-host-token'],
    ]);
    expect(JSON.parse(String(requests[1]?.[1]?.body))).toEqual(selection);

    fetchWithoutRuntimeRouting.mockResolvedValue(Response.json([]));
    await api.pluginCenter!.checkUpdates();
    expect(String(fetchWithoutRuntimeRouting.mock.calls[0]?.[0])).toBe('https://localhost/api/varin/extensions/v1/updates');
    expect(new Headers(fetchWithoutRuntimeRouting.mock.calls[0]?.[1]?.headers).has('Authorization')).toBe(false);
  });

  it('rejects a workbench response received after switching Hosts', async () => {
    switchRuntimeEndpoint({ apiBaseUrl: firstHost, clientToken: 'first-host-token' });
    const { createWebExtensionsAPI } = await import('./extensions');
    let completeOldRequest!: (response: Response) => void;
    fetch.mockImplementation(async input => {
      if (String(input) === `${firstHost}/api/varin/extensions/v1/host-state`) {
        return new Promise(resolve => { completeOldRequest = resolve; });
      }
      return Response.json(String(input).endsWith('/url-token') ? {} : snapshot);
    });
    const api = createWebExtensionsAPI();
    const oldRequest = api.hostState();
    const rejected = expect(oldRequest).rejects.toThrow('Application Host changed');
    await vi.waitFor(() => expect(completeOldRequest).toBeTypeOf('function'));
    switchRuntimeEndpoint({ apiBaseUrl: secondHost, clientToken: 'second-host-token' });
    completeOldRequest(Response.json(snapshot));
    await rejected;
    await expect(api.hostState()).resolves.toMatchObject({ catalog: { hostId } });
    const [url, init] = fetch.mock.calls.at(-1)!;
    expect(String(url)).toBe(`${secondHost}/api/varin/extensions/v1/host-state`);
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer second-host-token');
  });
});

describe('createWebExtensionsAPI', () => {
  it('uses the same local authentication for plugin-center requests', async () => {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {
      __VARIN_LOCAL_ORIGIN__: 'http://127.0.0.1:57123',
      location: { href: 'varin-ui://app/', origin: 'varin-ui://app' },
    } });
    fetchWithoutRuntimeRouting.mockResolvedValue(Response.json([]));
    const { createWebExtensionsAPI } = await import('./extensions');
    await createWebExtensionsAPI().pluginCenter!.checkUpdates();
    const [target, init] = fetchWithoutRuntimeRouting.mock.calls[0] as [URL, RequestInit];
    expect(target.pathname).toBe('/api/varin/extensions/v1/updates');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer local-desktop-token');
  });

  it('reads from the application host instead of the selected Pi runtime', async () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        __VARIN_API_BASE_URL__: 'https://remote-pi.example',
        __VARIN_LOCAL_ORIGIN__: 'http://127.0.0.1:57123',
        location: { href: 'varin-ui://app/', origin: 'varin-ui://app' },
      },
    });
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
    const target = new URL(String(fetchWithoutRuntimeRouting.mock.calls[0]?.[0]));
    expect(target.origin).toBe('http://127.0.0.1:57123');
    expect(target.pathname).toBe('/api/varin/extensions/v1/catalog');
    expect(target.searchParams.has('varin_url_token')).toBe(false);
    expect(new Headers(fetchWithoutRuntimeRouting.mock.calls[0]?.[1]?.headers).get('Authorization')).toBe('Bearer local-desktop-token');
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
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer local-desktop-token');
    expect(new Headers(init.headers).get('Accept')).toBe('text/event-stream');
    expect(JSON.parse(String(init.body))).toEqual(request);
    expect(events[1]).toEqual({ kind: 'error', message: '连接断开' });
    stream.close();
    await watching;
    expect(fetchWithoutRuntimeRouting).toHaveBeenCalledTimes(1);
  });

  it('cancels a blocked reader and keeps the original invocation routing and AbortSignal', async () => {
    setup();
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
