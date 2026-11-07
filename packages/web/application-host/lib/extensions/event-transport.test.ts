import express from 'express';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterEach, expect, it } from 'vitest';
import type { EventTransportConsumer, EventTransportImport, FollowupEventSourceCheckpoint, FollowupPluginEventInput } from '../kernel/protocol.generated.js';
import { FULL_CONTROL_CAPABILITIES } from '../client-auth/remote-clients.js';
import { PluginEventTransport, registerPluginEventTransportRoutes } from './event-transport.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
const source = { extensionId: 'example.mail', sourceId: 'messages', connectionId: 'mailbox', accountId: 'real-account' };
const descriptor = { ...source, displayName: 'Messages', filterSchema: true, modes: ['poll'], credentials: 'required', recovery: 'history',
  available: true, connections: [{ connectionId: 'mailbox', accountId: source.accountId, displayName: 'Inbox', available: true }] };
const event: FollowupPluginEventInput = { eventId: 'stable-message', objectId: 'conversation', senderId: 'sender', revision: null, occurredAtMs: 1,
  state: { key: 'checks', sequence: 3, value: 'healthy' },
  attributes: {}, files: [{ fileId: 'pdf', filename: 'invoice.pdf', mimeType: 'application/pdf', bytesBase64: 'JVBERi0xLjQ=' }], echoOf: { followupId: 'foreign-followup', occurrenceId: 'foreign-occurrence', operationId: 'same-id-on-another-host' },
  content: { data: null, parts: [{ kind: 'text', text: 'Original message' }] } };
async function fixture(options: { failAdmission?: boolean; echoOwnerHostId?: string; failAckOnce?: boolean } = {}) {
  const app = express(); app.use(express.json());
  let consumer: EventTransportConsumer | null = null;
  let held: EventTransportImport[] = [], admitted = false, failAck = options.failAckOnce ?? false;
  const incomingEvent = { ...event, echoOf: { ...event.echoOf!, ...(options.echoOwnerHostId ? { ownerHostId: options.echoOwnerHostId } : {}) } };
  const commits: unknown[] = [], acknowledgements: number[] = [], calls: string[] = [];
  const sourceCatalog = {
    eventTransportBind: async (input: { key: EventTransportConsumer['key']; state: EventTransportConsumer['state'] }) => {
      calls.push('bind');
      consumer ??= { key: input.key, identity: { principalId: input.key.principalId, source }, generation: 1, coverageFromMs: 1, afterCursor: 0, offeredThrough: 0, state: input.state };
      consumer.state = input.state; return structuredClone(consumer);
    },
    eventTransportGet: async () => consumer && structuredClone(consumer),
    eventTransportRead: async () => { calls.push('read'); consumer!.offeredThrough = 7; return { consumer: structuredClone(consumer),
      events: consumer!.afterCursor < 7 ? [incomingEvent] : [], throughCursor: 7, status: null }; },
    eventTransportAck: async (input: { throughCursor: number }) => {
      calls.push('ack'); expect(admitted).toBe(true);
      if (failAck) { failAck = false; throw new Error('Acknowledgement response lost'); }
      acknowledgements.push(input.throughCursor);
      consumer!.afterCursor = input.throughCursor; return structuredClone(consumer);
    },
    eventTransportRelease: async () => { calls.push('release'); consumer!.state = 'released'; return structuredClone(consumer); },
  };
  registerPluginEventTransportRoutes(app, { hostId: 'source-host', catalog: sourceCatalog as never,
    sources: { discoverLocal: async () => [descriptor] as never, validateArrangement: async () => {}, reconcile: async () => {} },
    requireAuth: (req, res, next) => {
      if (req.headers.authorization !== 'Bearer saved-peer-token') { res.status(401).end(); return; }
      req.varinAuth = { type: 'client', clientId: 'client-B', principalId: 'source-user',
        client: { id: 'client-B', capabilities: [...FULL_CONTROL_CAPABILITIES], allowedDirectories: [] } }; next();
    }, isDraining: () => false });
  const server = createServer(app); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const host = { hostId: 'source-host', connectionId: 'saved-peer', endpointIdentity: 'verified-endpoint' };
  const identity = { principalId: 'receiving-user', source: { ...source, host } };
  const checkpoint: FollowupEventSourceCheckpoint = { identity, cursor: null, status: null };
  held = [{ identity, state: 'active' }];
  const target = { hostId: host.hostId, machineId: 'managed:source-host', connection: { id: 'saved-peer', label: 'A', apiUrl: url,
    clientToken: 'saved-peer-token', requestHeaders: {}, source: 'configured-host' as const }, identity: { protocolVersion: 1, hostId: host.hostId, capabilities: ['sources'],
      machine: { machineId: 'managed:source-host', kind: 'managed-remote', state: 'available' } } };
  let changed = () => {};
  const destination = {
    eventTransportImports: async () => structuredClone(held), eventSourceCheckpoint: async () => structuredClone(checkpoint),
    eventTransportImportReleased: async () => { held = []; }, updateEventSourceStatus: async ({ status }: { status: typeof checkpoint.status }) => {
      checkpoint.status = status; return structuredClone(checkpoint);
    },
    receivePluginEvents: async (input: { identity: unknown; events: typeof event[]; nextCursor: string }) => {
      calls.push('commit'); if (options.failAdmission) throw new Error('Destination unavailable');
      expect(input.identity).toEqual(identity); if (input.events.length) {
        expect(input.events[0]?.echoOf?.ownerHostId).toBe(options.echoOwnerHostId === 'receiver-host' ? null : options.echoOwnerHostId ?? 'source-host');
        expect(input.events[0]?.senderId).toBe('sender'); expect(input.events[0]?.files).toEqual(event.files);
        expect(input.events[0]?.state).toEqual(event.state);
      }
      commits.push(input); admitted = true; checkpoint.cursor = input.nextCursor;
      return { accepted: input.events.length, duplicates: 0, checkpoint: structuredClone(checkpoint) };
    },
    onEvent: (listener: (event: { stream: string }) => void) => { changed = () => listener({ stream: 'durable' }); return () => {}; },
    onExit: () => () => {}, onReady: () => () => {},
  };
  const transport = new PluginEventTransport('receiver-host', destination as never, {
    sourceTargets: async () => ({ targets: [{ resourceOwner: { kind: 'managed_host' as const, ...host }, label: 'Source A', capabilities: ['sources'] }], unavailable: [] }),
    forwardTarget: async owner => { expect(owner).toEqual({ kind: 'managed_host', ...host }); return target as never; },
  }, async principal => principal === 'receiving-user');
  cleanup.push(async () => { await transport.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { app, transport, sourceCatalog, commits, acknowledgements, checkpoint, calls, consumer: () => consumer,
    release: () => { held[0]!.state = 'released'; changed(); },
    pause: () => { held[0]!.state = 'paused'; changed(); }, resume: () => { held[0]!.state = 'active'; changed(); },
    restart: () => transport.reconcile() };
}
const until = async (predicate: () => boolean, timeout = 2_000) => {
  const end = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > end) throw new Error('Expected transport transition did not happen'); await new Promise(resolve => setTimeout(resolve, 5)); }
};
it('transfers over the saved authenticated Host connection and acknowledges only after destination admission', async () => {
  const f = await fixture();
  const discovered = await f.transport.discover('receiving-user');
  expect(discovered).toMatchObject([{ host: { hostId: 'source-host', connectionId: 'saved-peer' } }]);
  expect(await f.transport.discover('another-user')).toEqual([]);
  f.transport.start(); await until(() => f.acknowledgements.length > 0);
  expect(f.calls.indexOf('commit')).toBeLessThan(f.calls.indexOf('ack'));
  expect(f.consumer()?.identity.principalId).toBe('source-user');
  expect(f.commits).toHaveLength(1);
  f.release(); await until(() => f.consumer()?.state === 'released');
});
it('does not acknowledge a received page when the destination has not durably accepted it', async () => {
  const f = await fixture({ failAdmission: true }); f.transport.start();
  await until(() => f.calls.includes('commit'));
  expect(f.acknowledgements).toEqual([]); expect(f.checkpoint.cursor).toBeNull();
});
it('rejects caller-authored principals and unpaired ingress instead of exposing a forwarding endpoint', async () => {
  const f = await fixture();
  const body = { coordinatorHostId: 'receiver-host', subscriptionId: 'one', source, state: 'active' };
  await request(f.app).post('/api/harness/managed-execution/v1/events/bind').send(body).expect(401);
  await request(f.app).post('/api/harness/managed-execution/v1/events/bind').set('Authorization', 'Bearer saved-peer-token')
    .send({ ...body, principalId: 'victim' }).expect(503);
  expect(f.consumer()).toBeNull();
  await request(f.app).post('/api/harness/managed-execution/v1/events/bind').set('Authorization', 'Bearer saved-peer-token').send(body).expect(200);
  expect(f.consumer()?.key).toEqual({ principalId: 'source-user', clientId: 'client-B', coordinatorHostId: 'receiver-host', subscriptionId: 'one' });
});

it('preserves the receiving Host echo proof for original Catalog verification, and keeps files typed', async () => {
  const f = await fixture({ echoOwnerHostId: 'receiver-host' }); f.transport.start();
  await until(() => f.acknowledgements.length > 0);
  expect(f.commits).toHaveLength(1);
});
it('pauses the original consumer and resumes its acknowledged cursor without creating another subscription', async () => {
  const f = await fixture(); f.transport.start(); await until(() => f.acknowledgements.length > 0);
  const originalKey = f.consumer()!.key;
  f.pause(); await until(() => f.consumer()?.state === 'paused');
  expect(f.consumer()!.afterCursor).toBe(7);
  f.resume(); await until(() => f.consumer()?.state === 'active');
  expect(f.consumer()!.key).toEqual(originalKey); expect(f.commits).toHaveLength(1);
});

it('repairs a lost acknowledgement from the destination checkpoint without admitting the page twice', async () => {
  const f = await fixture({ failAckOnce: true }); f.transport.start();
  await until(() => f.calls.includes('ack'));
  expect(f.commits).toHaveLength(1); expect(f.acknowledgements).toEqual([]);
  await until(() => f.acknowledgements.length > 0, 7_000);
  expect(f.commits).toHaveLength(1); expect(f.consumer()!.afterCursor).toBe(7);
}, 10_000);
