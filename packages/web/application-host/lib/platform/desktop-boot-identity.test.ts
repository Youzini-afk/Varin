import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { acquireDesktopSessionLease } from './desktop-session-lease.js';
import { currentDesktopBootIdentity, type DesktopBootIdentity } from './desktop-boot-identity.js';
vi.mock('./desktop-boot-identity.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./desktop-boot-identity.js')>();
  return { ...actual, currentDesktopBootIdentity: vi.fn() };
});
const current = vi.mocked(currentDesktopBootIdentity);
const roots: string[] = [];
const directory = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'varin-boot-lease-')); roots.push(root); return root; };
const identity = (): DesktopBootIdentity => ({ hostUuid: randomUUID(), bootUuid: randomUUID() });
afterEach(() => { current.mockReset(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
describe('desktop reboot recovery', () => {
  it('retires an old scope only after this same host rebooted, even if its PID is now live', () => {
    const data = directory(), before = identity(); current.mockReturnValue(before);
    const old = acquireDesktopSessionLease(data), root = path.join(data, '.desktop-session.lock');
    fs.mkdirSync(path.join(root, 'scopes'));
    const token = randomUUID(), scope = { schema: 1, token, leaseToken: old.record.token, shellPid: process.pid, phase: 'active', guardianPid: process.pid, nodePid: process.pid };
    fs.writeFileSync(path.join(root, 'scopes', `${token}.json`), JSON.stringify(scope));
    current.mockReturnValue({ ...before, bootUuid: randomUUID() });
    const next = acquireDesktopSessionLease(data);
    expect(next.record.token).not.toBe(old.record.token);
    const retired = path.join(data, `.desktop-session-retired-${old.record.token}`);
    expect(JSON.parse(fs.readFileSync(path.join(retired, 'scopes', `${token}.json`), 'utf8'))).toEqual(scope);
    old.release();
    expect(() => acquireDesktopSessionLease(data)).toThrow('Another Varin');
    next.release(); expect(fs.existsSync(root)).toBe(false);
  });
  it('rejects another host instead of applying the local PID table to a shared-root owner', () => {
    const data = directory(); current.mockReturnValue(identity());
    const old = acquireDesktopSessionLease(data);
    current.mockReturnValue(identity());
    expect(() => acquireDesktopSessionLease(data)).toThrow('another or unconfirmed host');
    expect(fs.existsSync(path.join(data, '.desktop-session.lock'))).toBe(true);
    old.release();
  });
  it('does not infer a reboot from a missing identity, missing old proof, or the same boot', () => {
    const data = directory(), before = identity(); current.mockReturnValue(before);
    acquireDesktopSessionLease(data);
    expect(() => acquireDesktopSessionLease(data)).toThrow('Another Varin');
    current.mockReturnValue(undefined);
    expect(() => acquireDesktopSessionLease(data)).toThrow('identity is unavailable');
    fs.unlinkSync(path.join(data, '.desktop-session.lock', 'boot-session.json'));
    current.mockReturnValue(identity());
    expect(() => acquireDesktopSessionLease(data)).toThrow('Another Varin');
  });
  it('rejects malformed, oversized, mismatched, and unknown proof fields', () => {
    const data = directory(), before = identity(); current.mockReturnValue(before);
    acquireDesktopSessionLease(data);
    const file = path.join(data, '.desktop-session.lock', 'boot-session.json');
    const proof = JSON.parse(fs.readFileSync(file, 'utf8'));
    current.mockReturnValue({ ...before, bootUuid: randomUUID() });
    for (const change of [{ schema: 2 }, { source: 'clock' }, { ownerToken: randomUUID() }, { ownerPid: 0 }, { extra: true },
      { identity: { ...before, hostUuid: '00000000-0000-0000-0000-000000000000' } },
      { identity: { ...before, extra: true } }, { identity: null }]) {
      fs.writeFileSync(file, JSON.stringify({ ...proof, ...change }));
      expect(() => acquireDesktopSessionLease(data)).toThrow();
    }
    for (const bytes of ['{', ' '.repeat(4097)]) { fs.writeFileSync(file, bytes); expect(() => acquireDesktopSessionLease(data)).toThrow(); }
  });
  it.skipIf(process.platform === 'win32')('does not follow a substituted boot-proof symlink', () => {
    const data = directory(), before = identity(); current.mockReturnValue(before);
    acquireDesktopSessionLease(data);
    const file = path.join(data, '.desktop-session.lock', 'boot-session.json'), moved = `${file}.saved`;
    fs.renameSync(file, moved); fs.symlinkSync(moved, file);
    current.mockReturnValue({ ...before, bootUuid: randomUUID() });
    expect(() => acquireDesktopSessionLease(data)).toThrow('identity is invalid');
  });
});
