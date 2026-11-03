/** OS identity for cross-reboot lease recovery, not an executor/drain receipt. */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { DesktopSessionRecord } from './desktop-session-lease.js';
export interface DesktopBootIdentity { hostUuid: string; bootUuid: string }
const uuid = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)
  && value !== '00000000-0000-0000-0000-000000000000';
const source = 'darwin-platform-boot-v1';
export function currentDesktopBootIdentity(): DesktopBootIdentity | undefined {
  if (process.platform !== 'darwin') return undefined;
  try {
    const options = { encoding: 'utf8' as const, timeout: 1000, maxBuffer: 64 * 1024,
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'] };
    // XNU gethostuuid -> IOBSDGetPlatformUUID uses this exact platform property.
    // Fixed OS tools, no shell, environment-provided identity, or clock inference.
    const platform = execFileSync('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice', '-k', 'IOPlatformUUID'], options);
    const matches = [...platform.matchAll(/"IOPlatformUUID"\s*=\s*"([0-9a-fA-F-]+)"/gu)];
    if (matches.length !== 1) return undefined;
    const hostUuid = matches[0]![1]!.toLowerCase();
    const bootUuid = execFileSync('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], options).trim().toLowerCase();
    return uuid(hostUuid) && uuid(bootUuid) ? { hostUuid, bootUuid } : undefined;
  } catch { return undefined; } // No proof grants no additional recovery authority.
}
export function desktopBootRelation(directory: string, owner: DesktopSessionRecord, current: DesktopBootIdentity | undefined): 'unrecorded' | 'current' | 'previous' {
  const file = path.join(directory, 'boot-session.json');
  let stat: fs.Stats;
  try { stat = fs.lstatSync(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'unrecorded';
    throw new Error('Desktop boot identity cannot be inspected');
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error('Desktop boot identity is invalid');
  const descriptor = fs.openSync(file, 'r');
  let value: unknown;
  try {
    const bytes = Buffer.alloc(4097), length = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
    if (length > 4096) throw new Error('Desktop boot identity is invalid');
    value = JSON.parse(bytes.subarray(0, length).toString('utf8'));
  } finally { fs.closeSync(descriptor); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Desktop boot identity is invalid');
  const proof = value as Record<string, unknown>, identity = proof.identity as Partial<DesktopBootIdentity> | null;
  if (Object.keys(proof).some(key => !['schema', 'source', 'ownerToken', 'ownerPid', 'identity'].includes(key))
    || proof.schema !== 1 || proof.source !== source || proof.ownerToken !== owner.token || proof.ownerPid !== owner.pid
    || !identity || typeof identity !== 'object' || Array.isArray(identity)
    || Object.keys(identity).some(key => !['hostUuid', 'bootUuid'].includes(key)) || !uuid(identity.hostUuid) || !uuid(identity.bootUuid)) {
    throw new Error('Desktop boot identity does not match its original owner');
  }
  if (!current) throw new Error('Current desktop host/boot identity is unavailable; original ownership is retained');
  if (!uuid(current.hostUuid) || !uuid(current.bootUuid) || current.hostUuid !== identity.hostUuid) {
    // Never substitute this machine's PID table for a foreign shared-root owner.
    throw new Error('Desktop data belongs to another or unconfirmed host; original ownership is retained');
  }
  return current.bootUuid === identity.bootUuid ? 'current' : 'previous';
}
export function writeDesktopBootProof(directory: string, owner: DesktopSessionRecord, identity: DesktopBootIdentity | undefined): void {
  if (!identity) return;
  if (!uuid(identity.hostUuid) || !uuid(identity.bootUuid)) throw new Error('Desktop boot identity is invalid');
  const descriptor = fs.openSync(path.join(directory, 'boot-session.json'), 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, JSON.stringify({ schema: 1, source, ownerToken: owner.token, ownerPid: owner.pid, identity }));
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
}
