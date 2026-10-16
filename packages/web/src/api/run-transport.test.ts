import { beforeEach, describe, expect, it, vi } from 'vitest';

const { runtimeFetchMock } = vi.hoisted(() => ({ runtimeFetchMock: vi.fn() }));
vi.mock('@varin/application-client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@varin/application-client')>(), runtimeFetch: runtimeFetchMock,
}));
import { subscribeRunSse } from './run-transport';

beforeEach(() => runtimeFetchMock.mockReset());
describe('run observation response ownership', () => {
  it.each(['/api/tasks/events', '/api/debug/events', '/api/tests/events'])('releases rejected %s bodies without starting any operation', async path => {
    const cancelled = vi.fn();
    runtimeFetchMock.mockResolvedValueOnce(new Response(new ReadableStream({ cancel: cancelled }), { status: 401 }));
    const subscription = subscribeRunSse(path, 'workspace', () => undefined);
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledTimes(1));
    expect(runtimeFetchMock).toHaveBeenCalledTimes(1);
    expect(runtimeFetchMock.mock.calls[0]?.[0]).toBe(path);
    expect(runtimeFetchMock.mock.calls[0]?.[1]?.signal.aborted).toBe(true);
    subscription.close();
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it('releases a malformed stream without cancelling the underlying task', async () => {
    const cancelled = vi.fn();
    const response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('data: invalid-json\n\n')); }, cancel: cancelled,
    }));
    runtimeFetchMock.mockResolvedValueOnce(response);
    const subscription = subscribeRunSse('/api/tasks/events', 'workspace', () => undefined);
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(response.body!.locked).toBe(false));
    expect(runtimeFetchMock).toHaveBeenCalledTimes(1);
    subscription.close();
  });

  it('keeps a healthy reader active until the viewer closes it, then releases its lock', async () => {
    const cancelled = vi.fn();
    const listener = vi.fn();
    const response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('data: {"status":"running"}\n\n')); }, cancel: cancelled,
    }));
    runtimeFetchMock.mockResolvedValueOnce(response);
    const subscription = subscribeRunSse('/api/tasks/events', 'workspace', listener);
    await vi.waitFor(() => expect(listener).toHaveBeenCalledWith({ status: 'running' }));
    expect(cancelled).not.toHaveBeenCalled();
    expect(response.body!.locked).toBe(true);
    subscription.close();
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(response.body!.locked).toBe(false));
    expect(runtimeFetchMock).toHaveBeenCalledTimes(1);
  });
});
