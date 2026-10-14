import { describe, expect, it, vi } from 'vitest';
import { CaptureInventoryChangedError, createCaptureInventory, type CaptureInventoryOwner, type CaptureInventoryScan } from './capture-inventory.js';

const position: CaptureInventoryOwner = { epoch: 1, sourceId: 'original-watch', generation: 1, complete: true };
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};

const harness = (initial: string[]) => {
  const inventory = createCaptureInventory();
  const namespace = new Set(initial);
  const scan = vi.fn<CaptureInventoryScan>(async scopes => [...namespace].filter(file => (
    !scopes || scopes.some(scope => file === scope || file.startsWith(`${scope}/`))
  )));
  const capture = async (owner = position) => {
    const candidate = await inventory.prepare({ ...owner, scan });
    await inventory.verify(candidate, owner, scan);
    inventory.commit(candidate, owner);
    return candidate;
  };
  return { inventory, namespace, scan, capture };
};

describe('Documents capture inventory', () => {
  it('reuses only a successfully verified and committed namespace', async () => {
    const h = harness(['b', 'a']);
    const abandoned = await h.inventory.prepare({ ...position, scan: h.scan });
    expect(() => h.inventory.commit(abandoned, position)).toThrow('has not been verified');
    await h.inventory.verify(abandoned, position, h.scan);
    // A caller can abandon even a verified candidate when body capture fails.
    const committed = await h.capture();
    expect(h.scan).toHaveBeenCalledTimes(2);
    expect(committed.paths).toEqual(['a', 'b']);
    expect(Object.isFrozen(committed.paths)).toBe(true);
    h.scan.mockClear();
    expect((await h.capture()).paths).toEqual(['a', 'b']);
    expect(h.scan).not.toHaveBeenCalled();
    expect(() => h.inventory.commit(abandoned, position)).toThrow('changed during capture');
  });

  it('replaces compressed dirty subtrees with actual additions and deletions without crossing prefix boundaries', async () => {
    const h = harness(['a', 'a/old', 'ab', 'ab/keep', 'unchanged']);
    await h.capture();
    h.scan.mockClear();
    h.namespace.delete('a/old');
    h.namespace.add('a/new');
    h.namespace.add('a/new/deep');
    h.inventory.invalidate('a/old');
    h.inventory.invalidate('./a/');
    h.inventory.invalidate('a\\new\\deep');
    expect((await h.capture()).paths).toEqual(['a', 'a/new', 'a/new/deep', 'ab', 'ab/keep', 'unchanged']);
    expect(h.scan.mock.calls).toEqual([[['a']]]);

    for (const file of ['a', 'a/new', 'a/new/deep']) h.namespace.delete(file);
    h.namespace.add('added');
    h.namespace.add('added/child');
    h.inventory.invalidate('a');
    h.inventory.invalidate('added');
    expect((await h.capture()).paths).toEqual(['ab', 'ab/keep', 'added', 'added/child', 'unchanged']);
    expect(h.scan.mock.calls.at(-1)).toEqual([['a', 'added']]);
  });

  it('retains dirty work when a scoped scan fails or its candidate is abandoned', async () => {
    const h = harness(['entry']);
    await h.capture();
    h.inventory.invalidate('entry');
    h.namespace.delete('entry');
    h.scan.mockRejectedValueOnce(new Error('Rust scanner unavailable'));
    await expect(h.inventory.prepare({ ...position, scan: h.scan })).rejects.toThrow('Rust scanner unavailable');
    const abandoned = await h.inventory.prepare({ ...position, scan: h.scan });
    await h.inventory.verify(abandoned, position, h.scan);
    h.scan.mockClear();
    expect((await h.capture()).paths).toEqual([]);
    expect(h.scan.mock.calls).toEqual([[['entry']]]);
  });

  it('fully scans unknown coverage twice and does not carry reuse across that gap', async () => {
    const h = harness(['before']);
    await h.capture();
    h.scan.mockClear();
    h.namespace.delete('before');
    h.namespace.add('unobserved');
    const unknown = { ...position, complete: false };
    await h.capture(unknown);
    await h.capture(unknown);
    expect(h.scan.mock.calls).toEqual([[], [], [], []]);
    h.scan.mockClear();
    expect((await h.capture()).paths).toEqual(['unobserved']);
    expect(h.scan.mock.calls).toEqual([[]]);
    h.scan.mockClear();
    await h.capture();
    expect(h.scan).not.toHaveBeenCalled();
  });

  it('checks unknown inventory after capture and never upgrades an unknown candidate into a reusable baseline', async () => {
    const h = harness(['before']);
    const unknown = { ...position, complete: false };
    const changed = await h.inventory.prepare({ ...unknown, scan: h.scan });
    h.namespace.add('unobserved');
    await expect(h.inventory.verify(changed, unknown, h.scan)).rejects.toThrow('changed during capture');
    expect(() => h.inventory.commit(changed, unknown)).toThrow('has not been verified');
    const recovered = await h.inventory.prepare({ ...unknown, scan: h.scan });
    h.scan.mockClear();
    await h.inventory.verify(recovered, position, h.scan);
    h.inventory.commit(recovered, position);
    expect(h.scan.mock.calls).toEqual([[]]);
    h.scan.mockClear();
    await h.capture();
    expect(h.scan.mock.calls).toEqual([[]]);
  });

  it('drops reuse on reset, epoch change, generation change and replacement watcher', async () => {
    const h = harness(['initial']);
    await h.capture();
    const stale = await h.inventory.prepare({ ...position, scan: h.scan });
    await h.inventory.verify(stale, position, h.scan);
    h.inventory.invalidate();
    expect(() => h.inventory.commit(stale, position)).toThrow(CaptureInventoryChangedError);
    h.namespace.add('after-reset');
    h.scan.mockClear();
    expect((await h.capture()).paths).toContain('after-reset');
    await h.capture({ ...position, epoch: 2 });
    await h.capture({ ...position, epoch: 2, generation: 2 });
    await h.capture({ ...position, epoch: 2, generation: 2, sourceId: 'replacement-watch' });
    expect(h.scan.mock.calls).toEqual([[], [], [], []]);
  });

  it('refuses invalidations during asynchronous prepare without consuming the newer dirty scope', async () => {
    const h = harness(['a', 'b']);
    await h.capture();
    h.inventory.invalidate('a');
    const pending = deferred<string[]>();
    h.scan.mockImplementationOnce(() => pending.promise);
    const preparing = h.inventory.prepare({ ...position, scan: h.scan });
    h.namespace.delete('b');
    h.inventory.invalidate('b');
    pending.resolve(['a']);
    await expect(preparing).rejects.toThrow('changed during capture');
    h.scan.mockClear();
    expect((await h.capture()).paths).toEqual(['a']);
    expect(h.scan.mock.calls).toEqual([[['a', 'b']]]);
  });

  it('refuses duplicate hints during verification and changes between verification and commit', async () => {
    const h = harness(['a']);
    const unknown = { ...position, complete: false };
    const candidate = await h.inventory.prepare({ ...unknown, scan: h.scan });
    const pending = deferred<string[]>();
    h.scan.mockImplementationOnce(() => pending.promise);
    const verifying = h.inventory.verify(candidate, unknown, h.scan);
    h.inventory.invalidate('a');
    h.inventory.invalidate('a');
    pending.resolve(['a']);
    await expect(verifying).rejects.toThrow('changed during capture');
    expect(() => h.inventory.commit(candidate, unknown)).toThrow('changed during capture');

    await h.capture();
    const verified = await h.inventory.prepare({ ...position, scan: h.scan });
    await h.inventory.verify(verified, position, h.scan);
    h.namespace.add('new');
    h.inventory.invalidate('new');
    expect(() => h.inventory.commit(verified, position)).toThrow('changed during capture');
    expect((await h.capture()).paths).toEqual(['a', 'new']);
  });

  it('does not let a concurrent older candidate regress a newer committed namespace', async () => {
    const h = harness(['a']);
    const first = deferred<string[]>();
    h.scan.mockImplementationOnce(() => first.promise);
    const older = h.inventory.prepare({ ...position, scan: h.scan });
    const newer = await h.inventory.prepare({ ...position, scan: h.scan });
    await h.inventory.verify(newer, position, h.scan);
    h.inventory.commit(newer, position);
    first.resolve(['obsolete']);
    await expect(older).rejects.toThrow('changed during capture');

    const preparedFirst = await h.inventory.prepare({ ...position, scan: h.scan });
    const preparedSecond = await h.inventory.prepare({ ...position, scan: h.scan });
    await h.inventory.verify(preparedFirst, position, h.scan);
    await h.inventory.verify(preparedSecond, position, h.scan);
    h.inventory.commit(preparedSecond, position);
    expect(() => h.inventory.commit(preparedFirst, position)).toThrow('changed during capture');
    expect((await h.capture()).paths).toEqual(['a']);
  });

  it('normalizes namespace paths and excludes internal assets even when a dirty scan explicitly returns them', async () => {
    const h = harness(['./src/', 'src\\file', 'src/file', '.git/index', 'nested/.varin/data', '.gitignore', '.varin-extra']);
    expect((await h.capture()).paths).toEqual(['.gitignore', '.varin-extra', 'src', 'src/file']);
    h.scan.mockClear();
    h.inventory.invalidate('.git/index');
    h.inventory.invalidate('src/.varin/data');
    await h.capture();
    expect(h.scan).not.toHaveBeenCalled();
    h.inventory.invalidate('src');
    h.scan.mockResolvedValueOnce(['src', 'src/new', 'src/.git/config', 'src/.varin/objects']);
    expect((await h.capture()).paths).toEqual(['.gitignore', '.varin-extra', 'src', 'src/new']);
    expect(h.scan.mock.calls).toEqual([[['src']]]);
  });

  it('rejects scanner namespace escapes and conservatively resets malformed watch hints', async () => {
    const h = harness(['safe']);
    await h.capture();
    h.inventory.invalidate('safe');
    h.scan.mockResolvedValueOnce(['safe', 'safe-neighbor']);
    await expect(h.inventory.prepare({ ...position, scan: h.scan })).rejects.toThrow('escaped its requested scopes');
    h.inventory.invalidate('../outside');
    h.scan.mockClear();
    await h.capture();
    expect(h.scan.mock.calls).toEqual([[]]);
    for (const path of ['../escape', '/absolute', 'C:\\absolute', '\\\\server\\share', 'safe/../escape', 'bad\0name']) {
      h.inventory.invalidate();
      h.scan.mockResolvedValueOnce([path]);
      await expect(h.inventory.prepare({ ...position, scan: h.scan })).rejects.toThrow('outside its namespace');
    }
    const foreign = await harness(['other']).inventory.prepare({ ...position, scan: async () => ['other'] });
    await expect(h.inventory.verify(foreign, position, h.scan)).rejects.toThrow('does not belong to this watcher');
  });
});
