import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HarnessServiceError } from '../harness/service-error.js';
import type { VmExec } from './vm-provider.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const credentialPath = (dataDir: string, uuid: string): string => {
  if (!uuidPattern.test(uuid)) throw new HarnessServiceError('invalid-params', 'Invalid VM identity');
  return join(dataDir, 'computer-vms', `${uuid}.json`);
};

/** The password never appears in ComputerMachine, VM descriptors or settings. */
export async function vmGuestPassword(dataDir: string, uuid: string): Promise<string> {
  const path = credentialPath(dataDir, uuid);
  const read = async () => {
    const value = JSON.parse(await readFile(path, 'utf8')) as { password?: unknown };
    if (typeof value.password !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(value.password)) {
      throw new HarnessServiceError('unavailable', 'Saved VM guest credential is malformed');
    }
    return value.password;
  };
  try { return await read(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await mkdir(join(dataDir, 'computer-vms'), { recursive: true, mode: 0o700 });
  const password = randomBytes(32).toString('base64url');
  try { await writeFile(path, JSON.stringify({ schemaVersion: 1, password }), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return read(); throw error; }
  return password;
}

export const forgetVmGuestPassword = async (dataDir: string, uuid: string): Promise<void> => {
  await rm(credentialPath(dataDir, uuid), { force: true });
};

export async function vmGuestIpv4(exec: VmExec, uri: string, uuid: string): Promise<string | null> {
  for (const source of ['lease', 'agent']) {
    const result = await exec('virsh', ['-c', uri, 'domifaddr', uuid, '--source', source]).catch(() => null);
    if (!result || result.code !== 0) continue;
    const address = result.stdout.match(/\bipv4\s+((?:\d{1,3}\.){3}\d{1,3})\/\d+\b/iu)?.[1];
    if (address && address.split('.').every((part) => Number(part) <= 255) && !address.startsWith('127.')) return address;
  }
  return null;
}

export async function probeVmGuest(apiUrl: string, version: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const response = await fetchImpl(`${apiUrl}/health`, { redirect: 'error' });
  if (!response.ok) return null;
  const health = await response.json() as { status?: unknown; varinVersion?: unknown; serverId?: unknown };
  return health.status === 'ok' && health.varinVersion === version && typeof health.serverId === 'string' && health.serverId
    ? health.serverId : null;
}

/** Read cloud-init's own completion marker through the guest agent when HTTP
 * is not yet available. Missing agents are ordinary boot-in-progress state. */
export async function vmGuestBootstrapStatus(exec: VmExec, uri: string, uuid: string): Promise<string | null> {
  const command = async (payload: Record<string, unknown>) => {
    const result = await exec('virsh', ['-c', uri, 'qemu-agent-command', uuid, JSON.stringify(payload)]);
    if (result.code !== 0) throw new Error(result.stderr.trim());
    return JSON.parse(result.stdout) as { return?: unknown };
  };
  let handle: number | undefined;
  try {
    const opened = await command({ execute: 'guest-file-open', arguments: { path: '/var/lib/varin/bootstrap.status', mode: 'r' } });
    if (!Number.isSafeInteger(opened.return)) return null;
    handle = opened.return as number;
    const read = await command({ execute: 'guest-file-read', arguments: { handle, count: 1024 } });
    const body = read.return && typeof read.return === 'object' ? read.return as Record<string, unknown> : {};
    if (typeof body['buf-b64'] !== 'string') return null;
    return Buffer.from(body['buf-b64'], 'base64').toString('utf8').trim();
  } catch { return null; }
  finally {
    if (handle !== undefined) await command({ execute: 'guest-file-close', arguments: { handle } }).catch(() => undefined);
  }
}
