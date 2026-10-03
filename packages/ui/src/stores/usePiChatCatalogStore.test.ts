import { describe, expect, test } from 'vitest';
import type {
  PiCommandDescriptor,
  PiResourceCatalogSnapshot,
  RuntimeContextTarget,
} from '@varin/protocol';
import { createPiChatCatalogStore } from './usePiChatCatalogStore';

const target: RuntimeContextTarget = { sessionId: 'session-a' };
const targetKey = '["runtime-a","session","session-a"]';

const command = (name: string): PiCommandDescriptor => ({
  name,
  source: name.startsWith('skill:') ? 'skill' : 'extension',
  sourceInfo: {
    origin: 'package',
    path: `C:/commands/${name}`,
    scope: 'user',
    source: 'test',
  },
});

const emptySkills = (): PiResourceCatalogSnapshot => ({
  diagnostics: [],
  projectTrusted: true,
  resources: [],
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
};

describe('usePiChatCatalogStore', () => {
  test('deduplicates an in-flight load and waits for the authoritative result', async () => {
    const commands = deferred<PiCommandDescriptor[]>();
    const skills = deferred<PiResourceCatalogSnapshot>();
    let commandLoads = 0;
    const store = createPiChatCatalogStore({
      getRuntimeKey: () => 'runtime-a',
      listCommands: async () => {
        commandLoads += 1;
        return commands.promise;
      },
      listResources: async () => skills.promise,
    });

    const first = store.getState().load(target, targetKey);
    const second = store.getState().load(target, targetKey);
    expect(second).toBe(first);
    expect(commandLoads).toBe(1);

    commands.resolve([command('skill:review')]);
    skills.resolve(emptySkills());
    await first;

    expect(store.getState().entries[targetKey]?.loaded).toBe(true);
    expect(store.getState().entries[targetKey]?.skills[0]?.invocation).toBe('skill:review');
  });

  test('keeps the last good snapshot when a forced refresh fails', async () => {
    let fail = false;
    const store = createPiChatCatalogStore({
      getRuntimeKey: () => 'runtime-a',
      listCommands: async () => {
        if (fail) throw new Error('offline');
        return [command('reload')];
      },
      listResources: async () => emptySkills(),
    });

    await store.getState().load(target, targetKey);
    fail = true;
    await store.getState().load(target, targetKey, true);

    const entry = store.getState().entries[targetKey];
    expect(entry?.commands.map((item) => item.name)).toEqual(['reload']);
    expect(entry?.error).toBe('offline');
    expect(entry?.loaded).toBe(true);
    expect(entry?.loading).toBe(false);
  });

  test('rejects a late response after the target is invalidated', async () => {
    const commands = deferred<PiCommandDescriptor[]>();
    const store = createPiChatCatalogStore({
      getRuntimeKey: () => 'runtime-a',
      listCommands: async () => commands.promise,
      listResources: async () => emptySkills(),
    });

    const load = store.getState().load(target, targetKey);
    store.getState().invalidate(targetKey);
    commands.resolve([command('stale')]);
    await load;

    expect(store.getState().entries[targetKey]).toBeUndefined();
    expect(store.getState().epoch).toBe(1);
  });
});
