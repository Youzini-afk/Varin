import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WebSocket } from 'ws';
import { BrowserExecutionError, isBrowserExecutionError, type BrowserDeviceIdentity, type BrowserDeviceStatus, type BrowserInputRequest, type BrowserPresentationOwner } from '@varin/protocol';
import { BrowserDeviceWire, BROWSER_CONTROL_BYTES, BROWSER_REQUESTS, browserMediaMaxPayload, deferred, object, text } from './device-wire.js';
import type { BrowserActor, BrowserDeviceGrant } from './remote-owner.js';
import { parseBrowserAction, parseBrowserRead } from './desktop-invoke.js';
import { parseBrowserInput, parseBrowserClipboard } from './input-validation.js';

type Owner = BrowserPresentationOwner & { proveIdentity(hostId: string, challenge: string): { publicKey: string; signature: string }; act: BrowserPresentationOwner['act'] & ((pageId: string, action: import('@varin/protocol').BrowserAction, signal?: AbortSignal, user?: boolean) => Promise<import('@varin/protocol').BrowserActionResult>) };
interface Active { leaseId: string; controller: AbortController; completion: Promise<void> }
interface Connection { grant: BrowserDeviceGrant; wire: BrowserDeviceWire; state: 'connected' | 'disconnected' | 'revoking'; active: Map<string, Active>; streams: Map<string, { pageId: string; principalId: string; stop(): Promise<void> }>; receipts: Map<string, { leaseId: string; acknowledged: ReturnType<typeof deferred<void>> }>; closed: ReturnType<typeof deferred<void>>; revoked: boolean; revocationComplete: boolean; releaseEvents(): void; error?: string }
interface Admission { hostId: string; controller: AbortController; finished: ReturnType<typeof deferred<void>>; connection?: Connection }
interface TrustedTarget { apiBaseUrl: string; clientToken?: string; requestHeaders: Record<string, string>; connectionId?: string }

function files(value: unknown): { name: string; bytes: Uint8Array }[] {
  if (!Array.isArray(value)) throw new Error('Browser files must be an array');
  return value.map(file => { const item = object(file); if (!(item.bytes instanceof Uint8Array)) throw new Error('Browser files must use binary transport'); return { name: text(item.name), bytes: item.bytes }; });
}
function actor(value: unknown): BrowserActor {
  const item = object(value);
  if (item.kind === 'thread') return { kind: 'thread', threadId: text(item.threadId), runId: text(item.runId), invocationId: text(item.invocationId) };
  if (item.kind === 'user') return { kind: 'user', principalId: text(item.principalId) };
  throw new Error('Browser operation has no original actor');
}

/** Explicit local device grants. Ordinary Host sign-in never calls connect(). */
export class BrowserDeviceService {
  private identity?: Promise<BrowserDeviceIdentity>;
  private readonly connections = new Map<string, Connection>();
  private readonly all = new Set<Connection>();
  private admission: Admission | undefined;
  private readonly revokingHosts = new Map<string, number>();
  private disposed = false;
  constructor(private readonly options: { owner: Owner; identityFile: string; fetch?: typeof fetch }) {}
  private getIdentity(): Promise<BrowserDeviceIdentity> {
    return this.identity ??= (async () => {
      await mkdir(path.dirname(this.options.identityFile), { recursive: true });
      try { await writeFile(this.options.identityFile, JSON.stringify({ version: 1, deviceId: randomUUID() }), { flag: 'wx', mode: 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const identity = object(JSON.parse(await readFile(this.options.identityFile, 'utf8')));
      if (identity.version !== 1) throw new Error('Unsupported browser device identity; original file was preserved');
      return { deviceId: text(identity.deviceId), browserId: this.options.owner.browserId, ownerGeneration: this.options.owner.ownerGeneration, label: os.hostname() };
    })();
  }
  async status(): Promise<BrowserDeviceStatus> {
    return { ...await this.getIdentity(), connections: [...this.connections.values()].map(value => ({ hostId: value.grant.hostId, grantId: value.grant.grantId,
      state: value.state, ...(value.error ? { error: value.error } : {}) })) };
  }
  async invoke(value: unknown): Promise<BrowserDeviceStatus> {
    const request = object(value), args = object(request.args); text(request.windowLabel);
    if (args.action === 'status') { if (Object.keys(args).length !== 1) throw new Error('Unexpected browser status argument'); return this.status(); }
    const expectedHostId = text(args.expectedHostId);
    if (args.action === 'disconnect') { if (Object.keys(args).some(key => !['action', 'expectedHostId'].includes(key))) throw new Error('Unexpected browser disconnect argument'); await this.disconnect(expectedHostId); return this.status(); }
    if (args.action !== 'connect' || args.shareInteractiveProfile !== true || Object.keys(args).some(key => !['action', 'expectedHostId', 'shareInteractiveProfile'].includes(key))) throw new Error('Sharing this interactive browser profile requires explicit Browser device authorization');
    const raw = object(request.trustedTarget);
    if (typeof raw.relayHostId === 'string' && raw.relayHostId) throw new Error('Browser device registration over an encrypted relay is not available on this desktop. Select an authenticated direct Host connection; no relay credentials were transmitted.');
    const target: TrustedTarget = { apiBaseUrl: text(raw.apiBaseUrl), requestHeaders: object(raw.requestHeaders) as Record<string, string>,
      ...(typeof raw.clientToken === 'string' ? { clientToken: raw.clientToken } : {}), ...(typeof raw.connectionId === 'string' ? { connectionId: raw.connectionId } : {}) };
    if (Object.values(target.requestHeaders).some(value => typeof value !== 'string')) throw new Error('Invalid trusted Host headers');
    await this.connect(expectedHostId, target); return this.status();
  }
  private async connect(expectedHostId: string, target: TrustedTarget): Promise<void> {
    if (this.disposed) throw new Error('This Browser device service has been disposed');
    if (this.admission) throw new Error('A browser device connection is already being authorized');
    if (this.revokingHosts.has(expectedHostId)) throw new Error('The original Browser device authorization is still being revoked');
    const admission: Admission = { hostId: expectedHostId, controller: new AbortController(), finished: deferred<void>() };
    this.admission = admission;
    const signal = admission.controller.signal;
    try {
      const base = new URL(target.apiBaseUrl);
      if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('The selected Host has no supported direct Browser device endpoint');
      const headers = new Headers(target.requestHeaders);
      if (target.clientToken) headers.set('Authorization', `Bearer ${target.clientToken}`);
      headers.set('X-Varin-Browser-Host', expectedHostId);
      const request = async (suffix: string, body?: unknown) => {
        signal.throwIfAborted();
        const response = await (this.options.fetch ?? fetch)(`${base.href.replace(/\/$/u, '')}/api/browsers${suffix}`, { headers: body === undefined ? headers : new Headers([...headers, ['Content-Type', 'application/json']]),
          method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal });
        signal.throwIfAborted();
        if (response.headers.get('X-Varin-Browser-Host') !== expectedHostId) { await response.body?.cancel(); throw new Error('The selected connection reaches a different Browser Host'); }
        const result = object(await response.json());
        signal.throwIfAborted();
        if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : 'Browser Host rejected this device authorization');
        return result;
      };
      const catalog = await request('');
      if (catalog.hostId !== expectedHostId) throw new Error('Browser Host identity changed before authorization');
      const current = this.connections.get(expectedHostId);
      if (current?.state === 'connected') {
        if (Array.isArray(catalog.devices) && catalog.devices.some(raw => { const device = object(raw); return device.grantId === current.grant.grantId && device.state === 'connected'; })) return;
        current.wire.close();
      }
      for (const original of this.all) if (original.state === 'disconnected' && !original.active.size && !original.receipts.size) this.all.delete(original);
      if (this.all.size >= BROWSER_REQUESTS) throw new Error('Browser recovery window is full; wait for the original executors and receipts before adding another grant');
      const identity = await this.getIdentity();
      signal.throwIfAborted();
      const challenge = await request('/device-challenges', { ...identity, expectedHostId });
      if (challenge.hostId !== expectedHostId) throw new Error('Browser identity challenge changed its Host');
      const proof = this.options.owner.proveIdentity(expectedHostId, text(challenge.challenge));
      const issued = await request('/device-grants', { ...identity, expectedHostId, shareInteractiveProfile: true, challengeId: text(challenge.challengeId), ...proof });
      signal.throwIfAborted();
      const grant: BrowserDeviceGrant = { ...identity, hostId: expectedHostId, grantId: text(issued.grantId) };
      const socket = (lane: 'control' | 'media', token: string) => {
        const url = new URL(`${base.href.replace(/\/$/u, '')}/api/browsers/devices/${lane}`); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        return new WebSocket(url, { headers: { ...Object.fromEntries(headers), 'X-Varin-Browser-Grant': token }, followRedirects: false, perMessageDeflate: false,
          maxPayload: lane === 'control' ? BROWSER_CONTROL_BYTES : browserMediaMaxPayload, handshakeTimeout: 30_000 });
      };
      const wire = new BrowserDeviceWire(socket('control', text(issued.controlToken)), socket('media', text(issued.mediaToken)));
      const ready = deferred<void>();
      const connection: Connection = { grant, wire, state: 'disconnected', active: new Map(), streams: new Map(), receipts: new Map(), closed: deferred<void>(), revoked: false, revocationComplete: false, releaseEvents: () => {} };
      admission.connection = connection;
      this.all.add(connection);
      const cancelled = new Map<string, string>(); let sequence = 0;
      wire.onMessage = message => {
        if (message.kind === 'connected') {
          if (message.hostId !== expectedHostId || message.grantId !== grant.grantId || connection.revoked) { wire.close(); return; }
          connection.state = 'connected'; ready.resolve(); return;
        }
        try {
          for (const key of ['hostId', 'grantId', 'deviceId', 'browserId', 'ownerGeneration'] as const) if (message[key] !== grant[key]) throw new Error('Browser request authority changed');
          const requestId = text(message.requestId), leaseId = text(message.leaseId);
          if (message.kind === 'receipt-ack' || message.kind === 'recovery-ack') {
            const original = message.kind === 'receipt-ack' ? connection : [...this.all].find(value => value.grant.hostId === expectedHostId && value.grant.grantId === message.originalGrantId);
            const receipt = original?.receipts.get(requestId);
            if (receipt && receipt.leaseId !== leaseId) throw new Error('Browser receipt acknowledgement lease changed');
            receipt?.acknowledged.resolve(); original?.receipts.delete(requestId); return;
          }
          if (message.kind === 'cancel') {
            const active = connection.active.get(requestId);
            if (active && active.leaseId !== leaseId) throw new Error('Browser cancellation lease changed');
            if (active) active.controller.abort(new Error('The original Host cancelled this browser request'));
            else { if (cancelled.size >= BROWSER_REQUESTS) throw new Error('Browser cancellation window exceeded'); cancelled.set(requestId, leaseId); }
            return;
          }
          if (message.kind !== 'call' || typeof message.sequence !== 'number' || !Number.isSafeInteger(message.sequence) || message.sequence <= sequence) throw new Error('Stale or repeated browser request');
          sequence = message.sequence;
          if (connection.active.size + connection.receipts.size >= BROWSER_REQUESTS || connection.active.has(requestId)) throw new Error('Browser request window exceeded');
          const controller = new AbortController();
          if (cancelled.get(requestId) === leaseId) { cancelled.delete(requestId); controller.abort(new Error('Browser request was cancelled before dispatch')); }
          const caller = actor(message.actor), method = text(message.method), args = object(message.args);
          const completion = this.execute(connection, requestId, leaseId, caller, method, args, controller);
          connection.active.set(requestId, { leaseId, controller, completion });
          void completion.then(() => connection.active.delete(requestId), () => { connection.error = 'An original browser executor has not confirmed stop'; });
        } catch { wire.close(); }
      };
      wire.onClose = () => {
        connection.closed.resolve();
        connection.state = connection.revoked && !connection.revocationComplete ? 'revoking' : 'disconnected';
        connection.error = 'Browser connection ended; earlier effects may still be running. Reconnect to inspect, never replay them automatically.';
        ready.reject(new Error('Browser device connection failed'));
        connection.releaseEvents();
        // UI/network loss ends only observations. It does not cancel Host work.
        for (const stream of connection.streams.values()) void stream.stop().catch(() => {});
        connection.streams.clear();
      };
      const timeout = setTimeout(() => { ready.reject(new Error('Browser device handshake timed out')); wire.close(); }, 30_000); timeout.unref();
      try { await ready.promise; } finally { clearTimeout(timeout); }
      signal.throwIfAborted();
      connection.releaseEvents = this.options.owner.subscribe(event => { void wire.send({ kind: 'event', event }).catch(() => wire.close()); });
      this.connections.set(expectedHostId, connection);
      for (const original of this.all) if (original !== connection && original.grant.hostId === expectedHostId) for (const [requestId, receipt] of original.receipts) {
        await wire.send({ kind: 'recovered-stop', originalGrantId: original.grant.grantId, requestId, leaseId: receipt.leaseId, executorStopped: true });
      }
      signal.throwIfAborted();
    } finally {
      if (this.admission === admission) this.admission = undefined;
      admission.finished.resolve();
    }
  }
  private cancelAdmission(hostId?: string): Admission | undefined {
    const admission = this.admission;
    if (!admission || hostId !== undefined && admission.hostId !== hostId) return;
    // Withdrawal includes requests still fetching the challenge/grant and
    // sockets waiting for admission. They may never publish a late connection.
    admission.controller.abort(new Error('Browser device authorization was withdrawn'));
    if (admission.connection) {
      admission.connection.revoked = true;
      admission.connection.wire.close();
    }
    return admission;
  }
  private async execute(connection: Connection, requestId: string, leaseId: string, caller: BrowserActor, method: string, args: Record<string, unknown>, controller: AbortController): Promise<void> {
    const { owner } = this.options, signal = controller.signal;
    const send = async (message: Record<string, unknown>) => {
      const terminal = message.executorStopped === true || message.kind === 'response' && message.ok === false && object(message.error).executorStopped === true;
      if (terminal && !connection.receipts.has(requestId)) connection.receipts.set(requestId, { leaseId, acknowledged: deferred<void>() });
      try {
        await connection.wire.send({ ...message, requestId, leaseId });
        if (terminal && connection.revoked && method !== 'revoke') await Promise.race([connection.receipts.get(requestId)?.acknowledged.promise, connection.closed.promise]);
      } catch { /* Preserve the original terminal receipt for reconnect. */ }
      const current = this.connections.get(connection.grant.hostId);
      if (terminal && current && current !== connection) {
        try {
          await current.wire.send({ kind: 'recovered-stop', originalGrantId: connection.grant.grantId, requestId, leaseId, executorStopped: true });
          // Revocation may close the last live wire. Let the Host observe the
          // original stop before closing, or retain its receipt after wire loss.
          if (current.revoked) await Promise.race([connection.receipts.get(requestId)?.acknowledged.promise, current.closed.promise]);
        } catch { /* The terminal receipt remains available on explicit reconnect. */ }
      }
    };
    let entered = false;
    try {
      signal.throwIfAborted();
      if (connection.revoked) throw new Error('This Browser device grant was revoked');
      const pageId = () => text(args.pageId);
      const human = () => { if (caller.kind !== 'user') throw new Error('Human browser input requires the original authenticated user actor'); };
      const viewer = (streamId: string, expectedPage = pageId()) => {
        human(); const stream = connection.streams.get(streamId);
        if (caller.kind !== 'user' || !stream || stream.pageId !== expectedPage || stream.principalId !== caller.principalId) throw new BrowserExecutionError('This browser viewer belongs to another authenticated user', 'none');
      };
      const threadId = () => {
        const id = text(args.threadId);
        if (caller.kind === 'thread' && id !== caller.threadId) throw new Error('Browser Thread retention changed its original actor');
        return `${connection.grant.hostId}:${id}`;
      };
      entered = true;
      let result: unknown;
      switch (method) {
        case 'list': result = await owner.list(); break;
        case 'open': {
          const input = object(args.input);
          if (input.retained !== undefined && typeof input.retained !== 'boolean') throw new Error('Invalid retained browser page');
          result = await owner.open({ url: text(input.url), ...(input.pageId === undefined ? {} : { pageId: text(input.pageId) }), ...(input.retained === undefined ? {} : { retained: input.retained }) },
            { signal, ...(args.threadId === undefined ? {} : { threadId: threadId() }) }); break;
        }
        case 'read': result = await owner.read(parseBrowserRead(args), signal); break;
        case 'act': if (args.user === true) human(); result = await owner.act(pageId(), parseBrowserAction(args.action), signal, args.user === true); break;
        case 'downloads': result = await owner.downloads(pageId()); break;
        case 'readDownload': result = await owner.readDownload(pageId(), text(args.downloadId), signal); break;
        case 'releaseDownload': result = await owner.releaseDownload(pageId(), text(args.downloadId)); break;
        case 'upload': result = await owner.upload(pageId(), text(args.ref), files(args.files), signal); break;
        case 'retainForThread': result = await owner.retainForThread(pageId(), threadId()); break;
        case 'releaseThread': result = await owner.releaseThread(threadId()); break;
        case 'takeControl': viewer(text(args.viewerId)); if (typeof args.paused !== 'boolean') throw new Error('Browser control requires paused'); result = await owner.takeControl(pageId(), args.paused, text(args.viewerId)); break;
        case 'subscribeFrames': {
          human(); const streamId = text(args.streamId); if (connection.streams.has(streamId)) throw new Error('Browser stream already exists');
          const stop = await owner.subscribeFrames(pageId(), streamId, frame => connection.wire.frame(frame));
          if (connection.state !== 'connected' || connection.revoked) { await stop(); throw new Error('The original browser observer disconnected'); }
          connection.streams.set(streamId, { pageId: pageId(), principalId: (caller as { principalId: string }).principalId, stop }); result = null; break;
        }
        case 'unsubscribeFrames': { const id = text(args.streamId); viewer(id); const stream = connection.streams.get(id); connection.streams.delete(id); await stream?.stop(); result = null; break; }
        case 'clipboard': viewer(text(args.streamId)); result = await owner.clipboard(parseBrowserClipboard(args), signal); break;
        case 'input': viewer(text(args.streamId)); await owner.input(parseBrowserInput(args) as BrowserInputRequest, signal); result = null; break;
        case 'resize': viewer(text(args.streamId)); if (typeof args.width !== 'number' || typeof args.height !== 'number') throw new Error('Invalid browser viewport'); await owner.resize(pageId(), text(args.streamId), args.width, args.height); result = null; break;
        case 'chooseFiles': { human(); const page = (await owner.list()).find(value => value.pageId === pageId()); if (!page?.controlViewerId || page.fileChooser?.chooserId !== args.chooserId) throw new Error('The original file chooser has no human lease'); viewer(page.controlViewerId); await owner.chooseFiles(pageId(), text(args.chooserId), files(args.files), signal); result = null; break; }
        case 'revoke': human(); await this.revokeHost(connection.grant.hostId, connection, requestId); result = null; break;
        default: entered = false; throw new Error('Unknown browser device operation');
      }
      await send({ kind: 'response', ok: true, executorStopped: true, result: result ?? null });
    } catch (error) {
      const execution = isBrowserExecutionError(error) ? error : new BrowserExecutionError(error, entered && ['open', 'act', 'upload', 'input', 'clipboard', 'chooseFiles'].includes(method) ? 'unknown' : 'none');
      await send({ kind: 'response', ok: false, error: { message: execution.message, effect: execution.effect, executorStopped: execution.executorStopped, pendingCompletion: Boolean(execution.completion) } });
      if (execution.completion) { await execution.completion; await send({ kind: 'stopped', executorStopped: true }); }
      else if (!execution.executorStopped) throw execution;
    }
  }
  private async revoke(connection: Connection, except?: string): Promise<void> {
    connection.revoked = true; connection.state = 'revoking'; connection.releaseEvents();
    const active = [...connection.active].filter(([id]) => id !== except).map(([, value]) => value);
    for (const value of active) value.controller.abort(new Error('The user revoked this Browser device grant'));
    await Promise.all([...connection.streams.values()].map(stream => stream.stop())); connection.streams.clear();
    await Promise.all(active.map(value => value.completion)); connection.revocationComplete = true; connection.state = 'disconnected';
  }
  private async revokeHost(hostId: string, current?: Connection, except?: string): Promise<void> {
    this.revokingHosts.set(hostId, (this.revokingHosts.get(hostId) ?? 0) + 1);
    const admission = this.cancelAdmission(hostId);
    try {
      const originals = [...this.all].filter(connection => connection.grant.hostId === hostId);
      for (const connection of originals) { connection.revoked = true; connection.state = 'revoking'; }
      await Promise.all([...originals.map(connection => this.revoke(connection, connection === current ? except : undefined)), admission?.finished.promise]);
    } finally {
      const remaining = this.revokingHosts.get(hostId)! - 1;
      if (remaining) this.revokingHosts.set(hostId, remaining); else this.revokingHosts.delete(hostId);
    }
  }
  async disconnect(hostId: string): Promise<void> {
    await this.revokeHost(hostId);
    for (const connection of this.all) if (connection.grant.hostId === hostId) { connection.wire.close(); if (!connection.receipts.size) this.all.delete(connection); }
    this.connections.delete(hostId);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const admission = this.cancelAdmission();
    for (const connection of this.all) { await this.revoke(connection); connection.wire.close(); }
    await admission?.finished.promise;
    this.all.clear(); this.connections.clear();
  }
}
