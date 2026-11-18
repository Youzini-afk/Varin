/* Device registry: the service's own machine identity and the user's confirmed grouping of records that
 * belong to one machine. The records themselves stay with their owners (connections, paired clients,
 * browsers, desktops); this owner only stores which record keys the user grouped or kept apart. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express, { type Express, type RequestHandler } from 'express';
import { hasHostConnectionAccess } from '../connections/access.js';

/** Record keys are `<owner>:<id>`, for example `service:self`, `connection:home`, `client:<id>`, `browser:<id>`, `machine:<id>`. */
const MEMBER_KEY = /^(service|connection|client|browser|machine|directory):[A-Za-z0-9._:@/-]{1,200}$/;
const MAX_GROUPS = 500;
const MAX_NAME = 80;

export interface DeviceGroup { id: string; name: string | null; members: string[] }
export interface DeviceAssociations { version: 1; groups: DeviceGroup[]; distinct: Array<[string, string]> }
export interface DeviceSelf {
  name: string;
  machine: { hostname: string; platform: NodeJS.Platform; release: string; arch: string; addresses: string[] };
}

const EMPTY: DeviceAssociations = { version: 1, groups: [], distinct: [] };
const revisionOf = (text: string) => createHash('sha256').update(text).digest('hex');
const pairKey = (a: string, b: string) => (a < b ? `${a}\n${b}` : `${b}\n${a}`);

function memberKey(value: unknown): string {
  if (typeof value !== 'string' || !MEMBER_KEY.test(value)) throw new Error('Invalid device record key');
  return value;
}

/** Validates a whole associations document: each record belongs to at most one group, and no group joins records the user kept apart. */
export function parseDeviceAssociations(value: unknown): DeviceAssociations {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid device associations');
  const input = value as Record<string, unknown>;
  const groupsInput = input.groups ?? [];
  const distinctInput = input.distinct ?? [];
  if (!Array.isArray(groupsInput) || !Array.isArray(distinctInput)) throw new Error('Invalid device associations');
  if (groupsInput.length > MAX_GROUPS) throw new Error('Too many device groups');
  const distinct = new Map<string, [string, string]>();
  for (const pair of distinctInput) {
    if (!Array.isArray(pair) || pair.length !== 2) throw new Error('Invalid distinct device pair');
    const a = memberKey(pair[0]); const b = memberKey(pair[1]);
    if (a === b) throw new Error('A record cannot be kept apart from itself');
    distinct.set(pairKey(a, b), a < b ? [a, b] : [b, a]);
  }
  const seen = new Set<string>(); const ids = new Set<string>();
  const groups: DeviceGroup[] = [];
  for (const raw of groupsInput) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid device group');
    const group = raw as Record<string, unknown>;
    const id = typeof group.id === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(group.id) ? group.id : randomUUID();
    if (ids.has(id)) throw new Error('Duplicate device group');
    ids.add(id);
    if (!Array.isArray(group.members)) throw new Error('Invalid device group members');
    const members = [...new Set(group.members.map(memberKey))];
    if (members.length < 2) continue;
    for (const member of members) {
      if (seen.has(member)) throw new Error('A record can belong to only one device');
      seen.add(member);
    }
    for (let i = 0; i < members.length; i += 1) for (let j = i + 1; j < members.length; j += 1) {
      if (distinct.has(pairKey(members[i]!, members[j]!))) throw new Error('These records were marked as different devices');
    }
    const name = typeof group.name === 'string' && group.name.trim() ? group.name.trim().slice(0, MAX_NAME) : null;
    groups.push({ id, name, members });
  }
  return { version: 1, groups, distinct: [...distinct.values()] };
}

export function describeSelf(): DeviceSelf {
  const hostname = os.hostname()?.trim() || 'Varin';
  const addresses = Object.values(os.networkInterfaces()).flatMap(list => list ?? [])
    .filter(address => !address.internal && (address.family === 'IPv4' || address.family === 'IPv6') && !address.address.startsWith('fe80:'))
    .map(address => address.address);
  return { name: hostname, machine: { hostname, platform: process.platform, release: os.release(), arch: process.arch, addresses: [...new Set(addresses)] } };
}

export function createDeviceRegistry(dataDirectory: string) {
  const file = path.join(dataDirectory, 'device-associations.json');
  let tail = Promise.resolve();
  const read = async (): Promise<{ associations: DeviceAssociations; revision: string; error?: string }> => {
    let text: string;
    try { text = await readFile(file, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return { associations: EMPTY, revision: revisionOf('') };
    }
    try { return { associations: parseDeviceAssociations(JSON.parse(text)), revision: revisionOf(text) }; }
    // An unreadable document is reported, not silently replaced; the next confirmed write supersedes it.
    catch (error) { return { associations: EMPTY, revision: revisionOf(text), error: error instanceof Error ? error.message : String(error) }; }
  };
  const save = (value: unknown, revision: string) => {
    const run = tail.then(async () => {
      const associations = parseDeviceAssociations(value);
      if ((await read()).revision !== revision) throw Object.assign(new Error('Device grouping changed elsewhere; refresh and try again'), { status: 409 });
      const text = `${JSON.stringify(associations, null, 2)}\n`;
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await mkdir(dataDirectory, { recursive: true });
        await writeFile(temporary, text, { flag: 'wx' });
        await rename(temporary, file);
      } finally { await rm(temporary, { force: true }).catch(() => undefined); }
      return { associations, revision: revisionOf(text) };
    });
    tail = run.then(() => undefined, () => undefined);
    return run;
  };
  return { read, save };
}

export function registerDeviceRoutes(app: Express, registry: ReturnType<typeof createDeviceRegistry>, requireAuth: RequestHandler) {
  app.get('/api/devices/self', requireAuth, (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    const self = describeSelf();
    const remote = request.socket.remoteAddress ?? '';
    const local = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
    response.json({ ...self, local, clientId: request.varinAuth?.clientId ?? null });
  });
  app.get('/api/devices/associations', requireAuth, async (request, response, next) => {
    try {
      response.setHeader('Cache-Control', 'no-store');
      if (!hasHostConnectionAccess(request.varinAuth, 'configuration')) { response.status(403).json({ code: 'device-permission-denied', error: 'Host-wide device management permission is required' }); return; }
      response.json(await registry.read());
    } catch (error) { next(error); }
  });
  app.put('/api/devices/associations', requireAuth, express.json({ limit: '1mb' }), async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    if (!hasHostConnectionAccess(request.varinAuth, 'configuration')) { response.status(403).json({ code: 'device-permission-denied', error: 'Host-wide device management permission is required' }); return; }
    const body = request.body as { associations?: unknown; revision?: unknown };
    if (typeof body?.revision !== 'string') { response.status(400).json({ error: 'A revision is required' }); return; }
    try { response.json(await registry.save(body.associations, body.revision)); }
    catch (error) {
      const status = (error as { status?: number }).status ?? 400;
      response.status(status).json({ error: error instanceof Error ? error.message : 'Could not save device grouping' });
    }
  });
}
