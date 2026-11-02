import { describe, it, expect } from 'vitest';
import { ClientSettingConflict, clientSettingSnapshot, synchronousClientSetting } from './client-settings-authority';

describe('Surface settings owner consistency', () => {
  it('checks the actual current value and writes synchronously before yielding', async () => {
    let enabled = true;
    const authority = synchronousClientSetting(() => ({ enabled }), values => { enabled = values.enabled as boolean; });
    const initial = await clientSettingSnapshot(authority);
    expect(initial.consistency).toBe('compare-and-swap');
    enabled = false; // A direct UI edit, not a facade write.
    expect(() => authority.compareAndApply!({ enabled: true }, initial.revision)).toThrow(ClientSettingConflict);
    expect(enabled).toBe(false);
    const fresh = await clientSettingSnapshot(authority);
    const result = authority.compareAndApply!({ enabled: true }, fresh.revision);
    expect(enabled).toBe(true);
    expect(result.values).toEqual({ enabled: true });
    expect(result.revision).not.toBe(fresh.revision);
    expect((await clientSettingSnapshot(authority)).revision).toBe(result.revision);
  });

  it('never advertises CAS for an asynchronous external owner', async () => {
    const authority = { read: async () => ({ enabled: true }), apply: async () => {} };
    expect(await clientSettingSnapshot(authority)).toEqual({ values: { enabled: true }, consistency: 'last-write-wins' });
  });

  it('does not reuse an observation token across a replacement Surface owner', async () => {
    const create = () => synchronousClientSetting(() => ({ enabled: true }), () => {});
    const old = await clientSettingSnapshot(create());
    expect(() => create().compareAndApply!({ enabled: false }, old.revision)).toThrow(ClientSettingConflict);
  });
});
