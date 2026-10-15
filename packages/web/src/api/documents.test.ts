import { describe, expect, it, vi } from 'vitest';
import { DocumentsError, isDocumentsError } from '@varin/application-client';
import { getRuntimeEndpointGeneration, switchRuntimeEndpoint } from '@varin/application-client';

const { runtimeFetchMock } = vi.hoisted(() => ({ runtimeFetchMock: vi.fn() }));

vi.mock('@varin/application-client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@varin/application-client')>(),
  runtimeFetch: runtimeFetchMock,
}));

describe('createWebDocumentsAPI', () => {
  it('resolves workspaces through the documents host route', async () => {
    const { createWebDocumentsAPI } = await import('./documents');
    const api = createWebDocumentsAPI();
    runtimeFetchMock.mockResolvedValueOnce(Response.json({
      workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      hostId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    }));
    await expect(api.resolveWorkspace({ path: '/repo' })).resolves.toEqual({
      workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      hostId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    });
    expect(runtimeFetchMock).toHaveBeenLastCalledWith('/api/documents/workspace/resolve', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/repo' }),
    });
  });

  it('rejects stale completions after an application-host endpoint switch', async () => {
    const { createWebDocumentsAPI } = await import('./documents');
    const api = createWebDocumentsAPI();
    let resolveResponse: ((value: Response) => void) | undefined;
    runtimeFetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    }));
    const pending = api.read({
      workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      resourceId: 'note.txt',
    });
    switchRuntimeEndpoint({ apiBaseUrl: `https://documents-${getRuntimeEndpointGeneration()}.example` });
    resolveResponse?.(Response.json({ status: 'missing', resource: { workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', resourceId: 'note.txt' } }));
    await expect(pending).rejects.toBeInstanceOf(DocumentsError);
    await expect(pending).rejects.toMatchObject({ reason: 'stale-completion' });
  });

  it.each([
    { reason: 'maintenance', status: 409, expected: 'maintenance' },
    { reason: 'future-host-reason', status: 503, expected: 'failed' },
  ])('preserves $reason failures through the actual documents client', async ({ reason, status, expected }) => {
    const { createWebDocumentsAPI } = await import('./documents');
    const api = createWebDocumentsAPI();
    runtimeFetchMock.mockResolvedValueOnce(Response.json({
      error: 'Workspace is unavailable', reason,
    }, { status }));

    const pending = api.read({
      workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      resourceId: 'note.txt',
    });
    await expect(pending).rejects.toSatisfy(isDocumentsError);
    await expect(pending).rejects.toMatchObject({ reason: expected, status });
  });

  it('publishes live dirty buffers through the document authority', async () => {
    const { createWebDocumentsAPI } = await import('./documents');
    const api = createWebDocumentsAPI();
    const request = {
      generation: 2,
      ownerId: 'surface-1',
      resources: [{
        baseRevision: null,
        localEditRevision: 3,
        resource: { workspaceId: 'workspace-1', resourceId: 'note.txt' },
      }],
      workspaceId: 'workspace-1',
    };
    runtimeFetchMock.mockResolvedValueOnce(Response.json({
      ...request,
      updatedAt: '2026-08-28T00:00:00.000Z',
    }));
    await expect(api.publishDirtyBuffers(request)).resolves.toMatchObject({ ownerId: 'surface-1' });
    expect(runtimeFetchMock).toHaveBeenLastCalledWith('/api/documents/dirty/publish', expect.objectContaining({
      body: JSON.stringify(request),
      method: 'POST',
    }));
  });

  it('opens document watches without putting credentials in the URL', async () => {
    const { createWebDocumentsAPI } = await import('./documents');
    const api = createWebDocumentsAPI();
    runtimeFetchMock.mockResolvedValueOnce(new Response(new ReadableStream(), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }));
    const subscription = api.watch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', () => undefined, {
      dirtyOwner: { generation: 3, ownerId: 'surface-1' },
    });
    await vi.waitFor(() => expect(runtimeFetchMock).toHaveBeenCalled());
    expect(runtimeFetchMock).toHaveBeenLastCalledWith('/api/documents/watch', expect.objectContaining({
      headers: { Accept: 'text/event-stream' },
      query: {
        dirtyOwnerGeneration: '3',
        dirtyOwnerId: 'surface-1',
        workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      },
    }));
    const query = runtimeFetchMock.mock.calls.at(-1)?.[1]?.query as { workspaceId?: string };
    expect(JSON.stringify(query)).not.toMatch(/token|bearer|password/i);
    subscription.close();
  });

  it('delivers dirty-state barrier controls outside file-event sequencing', async () => {
    const { createWebDocumentsAPI } = await import('./documents');
    const api = createWebDocumentsAPI();
    const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const control = {
      action: 'acquire',
      barrierId: 'barrier-1',
      caseSensitive: true,
      kind: 'dirty-state-barrier',
      paths: ['note.txt'],
      workspaceId,
    } as const;
    const encoder = new TextEncoder();
    runtimeFetchMock.mockResolvedValueOnce(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(control)}\n\n`));
      },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
    const events: unknown[] = [];
    const subscription = api.watch(workspaceId, (event) => events.push(event), {
      dirtyOwner: { generation: 3, ownerId: 'surface-1' },
    });
    await vi.waitFor(() => expect(events).toContainEqual(control));
    subscription.close();

    runtimeFetchMock.mockResolvedValueOnce(Response.json({ acknowledged: true }));
    await expect(api.ackDirtyStateBarrier?.({
      barrierId: 'barrier-1',
      generation: 3,
      ownerId: 'surface-1',
      workspaceId,
    })).resolves.toEqual({ acknowledged: true });
    expect(runtimeFetchMock).toHaveBeenLastCalledWith('/api/documents/dirty/barrier/ack', expect.objectContaining({
      method: 'POST',
    }));
  });

  it('delivers surface operations without consuming or resetting file-event positions', async () => {
    const { createWebDocumentsAPI } = await import('./documents');
    const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const changed = (sequence: number) => ({
      kind: 'changed', sourceId: 'source-1', generation: 1, sequence,
      resource: { workspaceId, resourceId: 'draft.txt' },
    });
    const controls = ['capture', 'apply', 'undo'].map((action) => ({
      kind: 'surface-operation', action, requestId: `request-${action}`,
      operationId: 'operation-1', workspaceId,
    }));
    const sent = [changed(1), ...controls, changed(2)];
    runtimeFetchMock.mockResolvedValueOnce(new Response(new ReadableStream({
      start(controller) {
        for (const event of sent) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
      },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
    const events: unknown[] = [];
    const subscription = createWebDocumentsAPI().watch(workspaceId, (event) => events.push(event), {
      dirtyOwner: { generation: 1, ownerId: 'surface-1' },
    });
    try {
      await vi.waitFor(() => expect(events).toEqual(sent));
    } finally {
      subscription.close();
    }
  });

  it('reconnects an ended watch and tells consumers to resynchronize', async () => {
    const { createWebDocumentsAPI } = await import('./documents');
    const api = createWebDocumentsAPI();
    runtimeFetchMock
      .mockResolvedValueOnce(new Response('', { status: 200, headers: { 'Content-Type': 'text/event-stream' } }))
      .mockResolvedValueOnce(new Response(new ReadableStream(), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }));
    const events: unknown[] = [];
    const subscription = api.watch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', (event) => events.push(event));
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
      kind: 'reset',
      sequence: 0,
      reason: 'reconnected',
    })), {
      timeout: 2_000,
    });
    subscription.close();
  });

  it('turns a same-generation sequence gap into a workspace reset', async () => {
    const { createWebDocumentsAPI } = await import('./documents');
    const api = createWebDocumentsAPI();
    const encoder = new TextEncoder();
    const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    runtimeFetchMock.mockResolvedValueOnce(new Response(new ReadableStream({
      start(controller) {
        for (const sequence of [1, 3]) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({
            sourceId: 'source-1',
            generation: 1,
            sequence,
            kind: 'changed',
            resource: { workspaceId, resourceId: 'note.txt' },
          })}\n\n`));
        }
      },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
    const events: unknown[] = [];
    const subscription = api.watch(workspaceId, (event) => events.push(event));
    await vi.waitFor(() => expect(events).toContainEqual({
      sourceId: 'source-1',
      generation: 1,
      sequence: 3,
      kind: 'reset',
      reason: 'gap',
    }));
    subscription.close();
  });

  it('does not turn a malformed recovery response into an empty list', async () => {
    const { createWebDocumentsAPI } = await import('./documents');
    const api = createWebDocumentsAPI();
    runtimeFetchMock.mockResolvedValueOnce(Response.json({}));
    await expect(api.listRecoveryJournals({
      workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    })).rejects.toBeInstanceOf(DocumentsError);
  });
});

describe('document observation response cleanup', () => {
  it('releases a rejected response before stopping or reconnecting', async () => {
    const { createWebDocumentsAPI } = await import('./documents');
    for (const status of [401, 503]) {
      runtimeFetchMock.mockReset();
      const cancelled = vi.fn();
      runtimeFetchMock.mockResolvedValueOnce(new Response(new ReadableStream({ cancel: cancelled }), { status }));
      const subscription = createWebDocumentsAPI().watch('workspace', () => undefined);
      await vi.waitFor(() => expect(cancelled).toHaveBeenCalledTimes(1));
      expect(runtimeFetchMock).toHaveBeenCalledTimes(1);
      subscription.close();
    }
  });

  it('cancels the original reader on parse failure and on disposal while blocked', async () => {
    const { createWebDocumentsAPI } = await import('./documents');
    for (const malformed of [true, false]) {
      runtimeFetchMock.mockReset();
      const cancelled = vi.fn();
      const response = new Response(new ReadableStream<Uint8Array>({
        start(controller) { if (malformed) controller.enqueue(new TextEncoder().encode('data: {bad-json}\n\n')); },
        cancel: cancelled,
      }), { headers: { 'Content-Type': 'text/event-stream' } });
      runtimeFetchMock.mockResolvedValueOnce(response);
      const subscription = createWebDocumentsAPI().watch('workspace', () => undefined);
      if (!malformed) {
        await vi.waitFor(() => expect(response.body!.locked).toBe(true));
        expect(cancelled).not.toHaveBeenCalled();
        subscription.close();
      }
      await vi.waitFor(() => expect(cancelled).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(response.body!.locked).toBe(false));
      expect(runtimeFetchMock).toHaveBeenCalledTimes(1);
      subscription.close();
    }
  });
});
