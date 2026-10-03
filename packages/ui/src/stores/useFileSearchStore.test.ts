import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type { RuntimeAPIs } from '@varin/application-client';
import { registerRuntimeAPIs } from '@/lib/runtime-api/registry';
import { switchRuntimeEndpoint } from '@varin/application-client';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

const searchRequests: Array<Deferred<Array<{ path: string }>>> = [];

const createDeferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const searchFilesMock = vi.fn(() => {
  const request = createDeferred<Array<{ path: string }>>();
  searchRequests.push(request);
  return request.promise;
});

const { useFileSearchStore } = await import('./useFileSearchStore');

const hit = (path: string) => ({
  extension: path.split('.').pop()?.toLowerCase(),
  name: path.split('/').pop() ?? path,
  path,
  relativePath: path.replace(/^\/project(?:::nested)?\/?/, ''),
});

describe('useFileSearchStore', () => {
  beforeEach(() => {
    searchRequests.length = 0;
    switchRuntimeEndpoint({ apiBaseUrl: 'http://runtime-a.local', runtimeKey: 'runtime-a' });
    registerRuntimeAPIs({
      files: { search: searchFilesMock },
    } as unknown as RuntimeAPIs);
    useFileSearchStore.setState({
      cache: {},
      cacheKeys: [],
      inFlight: {},
    });
  });

  test('does not cache a stale in-flight search after invalidation', async () => {
    const searchPromise = useFileSearchStore.getState().searchFiles('/project', 'foo');
    expect(Object.keys(useFileSearchStore.getState().inFlight)).toHaveLength(1);

    useFileSearchStore.getState().invalidateDirectory('/project');
    expect(Object.keys(useFileSearchStore.getState().inFlight)).toHaveLength(0);

    searchRequests[0].resolve([{ path: '/project/stale.ts' }]);
    await searchPromise;

    expect(useFileSearchStore.getState().cache).toEqual({});
    expect(useFileSearchStore.getState().cacheKeys).toEqual([]);
  });

  test('does not notify subscribers when stale search handlers make no state change', async () => {
    const searchPromise = useFileSearchStore.getState().searchFiles('/project', 'foo');
    useFileSearchStore.getState().invalidateDirectory('/project');

    let updateCount = 0;
    const unsubscribe = useFileSearchStore.subscribe(() => {
      updateCount += 1;
    });

    searchRequests[0].resolve([{ path: '/project/stale.ts' }]);
    await searchPromise;
    unsubscribe();

    expect(updateCount).toBe(0);
  });

  test('does not let a stale request remove a newer in-flight search', async () => {
    const stalePromise = useFileSearchStore.getState().searchFiles('/project', 'foo');
    useFileSearchStore.getState().invalidateDirectory('/project');
    const freshPromise = useFileSearchStore.getState().searchFiles('/project', 'foo');

    searchRequests[0].resolve([{ path: '/project/stale.ts' }]);
    await stalePromise;

    expect(Object.keys(useFileSearchStore.getState().inFlight)).toHaveLength(1);

    searchRequests[1].resolve([{ path: '/project/fresh.ts' }]);
    await freshPromise;

    const cacheEntries = Object.values(useFileSearchStore.getState().cache);
    expect(cacheEntries).toHaveLength(1);
    expect(cacheEntries[0]?.files).toEqual([hit('/project/fresh.ts')]);
  });

  test('keeps directory and query separators from colliding in cache keys', async () => {
    const firstPromise = useFileSearchStore.getState().searchFiles('/project::nested', 'foo');
    searchRequests[0].resolve([{ path: '/project::nested/first.ts' }]);
    await firstPromise;

    const secondPromise = useFileSearchStore.getState().searchFiles('/project', 'nested::foo');
    expect(searchRequests).toHaveLength(2);

    searchRequests[1].resolve([{ path: '/project/second.ts' }]);
    expect(await secondPromise).toEqual([hit('/project/second.ts')]);
  });

  test('isolates cache and in-flight ownership by runtime', async () => {
    const firstPromise = useFileSearchStore.getState().searchFiles('/project', 'foo');
    switchRuntimeEndpoint({ apiBaseUrl: 'http://runtime-b.local', runtimeKey: 'runtime-b' });
    const secondPromise = useFileSearchStore.getState().searchFiles('/project', 'foo');
    expect(searchRequests).toHaveLength(2);

    searchRequests[1].resolve([{ path: '/project/runtime-b.ts' }]);
    expect(await secondPromise).toEqual([hit('/project/runtime-b.ts')]);
    searchRequests[0].resolve([{ path: '/project/runtime-a.ts' }]);
    await firstPromise;

    switchRuntimeEndpoint({ apiBaseUrl: 'http://runtime-b.local', runtimeKey: 'runtime-b' });
    expect(await useFileSearchStore.getState().searchFiles('/project', 'foo')).toEqual([hit('/project/runtime-b.ts')]);
    expect(searchRequests).toHaveLength(2);
  });
});

afterAll(() => registerRuntimeAPIs(null));
