import { expect, test, vi } from 'vitest';
import { followThreadDeepLink } from './threadDeepLinkNavigation';
const intent = { type: 'thread', hostKey: JSON.stringify(['https://a.test', 'host:a']), threadId: 'thread:1', branchId: 'branch:review' } as const;
const identity = { runtime: 'agent', threadId: intent.threadId, branchId: intent.branchId } as const;
function fixture() {
  let host = 'host:b'; let generation = 0;
  return {
    currentHostKey: () => JSON.stringify(['https://b.test', host]), currentRuntimeKey: () => host,
    endpointGeneration: () => generation, isCurrent: () => true,
    connectHost: vi.fn(async () => { host = 'host:a'; generation++; return true; }),
    loadCatalog: vi.fn(async () => {}), openThread: vi.fn(async () => identity), openInstances: vi.fn(),
    switchAway: () => { host = 'host:c'; generation++; },
  };
}
test('a notification switches to its saved Host before opening the original branch', async () => {
  const runtime = fixture();
  await followThreadDeepLink(intent, runtime);
  expect(runtime.connectHost).toHaveBeenCalledWith(intent.hostKey);
  expect(runtime.openThread).toHaveBeenCalledWith({ threadId: intent.threadId, branchId: intent.branchId, directory: null });
});
test('unknown Hosts never open IDs on the current Host', async () => {
  const runtime = fixture(); runtime.connectHost.mockResolvedValue(false);
  await followThreadDeepLink(intent, runtime);
  expect(runtime.openInstances).toHaveBeenCalledOnce(); expect(runtime.loadCatalog).not.toHaveBeenCalled(); expect(runtime.openThread).not.toHaveBeenCalled();
});
test('Host changes while loading a catalog suppress the stale notification', async () => {
  const runtime = fixture(); runtime.loadCatalog.mockImplementation(async () => runtime.switchAway());
  await followThreadDeepLink(intent, runtime);
  expect(runtime.openThread).not.toHaveBeenCalled();
});
test('a newer navigation suppresses an older notification after Host connection', async () => {
  const runtime = fixture(); runtime.isCurrent = () => false;
  await followThreadDeepLink(intent, runtime);
  expect(runtime.openThread).not.toHaveBeenCalled();
});
