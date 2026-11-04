import { randomBytes, randomUUID, createHash, createPublicKey, verify } from 'node:crypto';
import type { WebSocket } from 'ws';
import { BrowserExecutionError, type BrowserAction, type BrowserCatalog, type BrowserDevice, type BrowserDeviceIdentity, type BrowserDownload, type BrowserEvent,
  type BrowserFrame, type BrowserClipboardRequest, type BrowserInputRequest, type BrowserObservation, type BrowserOwner, type BrowserPage, type BrowserPresentationOwner, type BrowserReadRequest } from '@varin/protocol';
import { BrowserDeviceWire, object, text } from './device-wire.js';
import { RemoteBrowserOwner, browserActor, type BrowserActor, type BrowserDeviceGrant } from './remote-owner.js';

type Registered = { device: BrowserDevice; owner: BrowserOwner; releaseEvents(): void; pages: Map<string, BrowserPage> };
type Grant = { identity: BrowserDeviceGrant; principalId: string; controlToken: string; mediaToken: string; expires: number; control?: WebSocket; media?: WebSocket; used: boolean };
export function presentationOwner(owner: BrowserOwner): BrowserPresentationOwner {
  if (!('subscribeFrames' in owner) || !('input' in owner) || !('takeControl' in owner)) throw new Error('This Browser device does not support live presentation');
  return owner as BrowserPresentationOwner;
}

/** Host-side selection and transport admission. All page business state remains
 * in the original local/remote BrowserOwner, including retention and input lanes. */
export class BrowserRegistry implements BrowserOwner {
  readonly browserId: string;
  private readonly devices = new Map<string, Registered>();
  private readonly grants = new Map<string, Grant>();
  private readonly challenges = new Map<string, { principalId: string; challenge: string; identity: BrowserDeviceIdentity; expires: number }>();
  private readonly retired = new Map<string, RemoteBrowserOwner>();
  private readonly viewers = new Map<string, { pageId: string; principalId: string }>();
  private readonly listeners = new Set<(event: BrowserEvent) => void>();
  private readonly pageOwners = new Map<string, string>();
  private readonly threadOwners = new Map<string, string>();
  private selected: string | null = null;
  constructor(readonly hostId: string, local?: BrowserOwner) {
    this.browserId = `varin:browser-registry:${hostId}`;
    if (local) { this.add({ hostId, deviceId: `host:${hostId}`, browserId: local.browserId, ownerGeneration: 'ownerGeneration' in local ? String(local.ownerGeneration) : local.browserId,
      label: 'Application Host', grantId: null, state: 'connected', local: true }, local); this.selected = local.browserId; }
  }
  available() { return [...this.devices.values()].some(value => value.device.state === 'connected'); }
  private add(device: BrowserDevice, owner: BrowserOwner) {
    const previous = this.devices.get(device.browserId);
    if (previous?.device.state === 'connected') throw new Error('This Browser owner is already connected');
    if (previous && (previous.device.deviceId !== device.deviceId || previous.device.ownerGeneration !== device.ownerGeneration)) throw new Error('Browser owner identity changed');
    previous?.releaseEvents();
    const entry: Registered = { device, owner, releaseEvents: () => {}, pages: previous?.pages ?? new Map() };
    entry.releaseEvents = owner.subscribe(event => {
      if (event.kind === 'page') this.remember(entry, event.page);
      else if (event.kind === 'closed') entry.pages.delete(event.pageId);
      for (const listener of this.listeners) listener(event);
    });
    this.devices.set(device.browserId, entry);
  }
  private remember(entry: Registered, page: BrowserPage) {
    if (page.browserId !== entry.device.browserId) throw new Error('Browser page belongs to another original owner');
    const recorded = this.pageOwners.get(page.pageId);
    if (recorded && recorded !== page.browserId) throw new Error('Browser page identity conflicts between devices');
    this.pageOwners.set(page.pageId, page.browserId); entry.pages.set(page.pageId, page);
  }
  forActor(actor: BrowserActor): BrowserOwner {
    const scoped = <T>(work: () => T): T => browserActor.run(actor, work);
    return { browserId: this.browserId,
      list: () => scoped(() => this.list()), open: (input, scope) => scoped(() => this.open(input, scope)), read: (input, signal) => scoped(() => this.read(input, signal)),
      act: (pageId, action, signal) => scoped(() => this.act(pageId, action, signal)), downloads: pageId => scoped(() => this.downloads(pageId)),
      readDownload: (pageId, downloadId, signal) => scoped(() => this.readDownload(pageId, downloadId, signal)), releaseDownload: (pageId, downloadId) => scoped(() => this.releaseDownload(pageId, downloadId)),
      upload: (pageId, ref, files, signal) => scoped(() => this.upload(pageId, ref, files, signal)), subscribe: listener => this.subscribe(listener),
      retainForThread: (pageId, threadId) => scoped(() => this.retainForThread(pageId, threadId)), releaseThread: threadId => scoped(() => this.releaseThread(threadId)) };
  }
  challenge(principalId: string, value: unknown) {
    const input = object(value);
    if (input.expectedHostId !== this.hostId) throw new Error('The Browser challenge must name its original Host');
    for (const [id, challenge] of this.challenges) if (challenge.expires <= Date.now()) this.challenges.delete(id);
    if (this.challenges.size >= 64) throw new Error('Browser identity challenge window is full');
    const identity: BrowserDeviceIdentity = { deviceId: text(input.deviceId), browserId: text(input.browserId), ownerGeneration: text(input.ownerGeneration), label: text(input.label) };
    const challengeId = randomUUID(), challenge = JSON.stringify([this.hostId, identity.deviceId, identity.browserId, identity.ownerGeneration, randomBytes(32).toString('base64url')]);
    this.challenges.set(challengeId, { principalId, challenge, identity, expires: Date.now() + 60_000 });
    return { challengeId, challenge, hostId: this.hostId };
  }
  issueGrant(principalId: string, value: unknown) {
    const input = object(value);
    if (input.expectedHostId !== this.hostId || input.shareInteractiveProfile !== true) throw new Error('Browser profile authorization must name this exact Host');
    for (const [id, grant] of this.grants) if (!grant.used && grant.expires < Date.now()) { grant.control?.terminate(); grant.media?.terminate(); this.grants.delete(id); }
    if ([...this.grants.values()].filter(grant => !grant.used).length >= 64) throw new Error('Browser authorization handshake window is full');
    const identity: BrowserDeviceIdentity = { deviceId: text(input.deviceId), browserId: text(input.browserId), ownerGeneration: text(input.ownerGeneration), label: text(input.label) };
    const challengeId = text(input.challengeId), challenge = this.challenges.get(challengeId);
    this.challenges.delete(challengeId);
    if (!challenge || challenge.expires <= Date.now() || challenge.principalId !== principalId || ['deviceId', 'browserId', 'ownerGeneration'].some(key => challenge.identity[key as keyof BrowserDeviceIdentity] !== identity[key as keyof BrowserDeviceIdentity])) throw new Error('Browser owner challenge is stale or belongs to another principal');
    const publicKey = Buffer.from(text(input.publicKey), 'base64');
    if (publicKey.byteLength > 256 || createHash('sha256').update(publicKey).digest('hex') !== identity.ownerGeneration || identity.browserId !== `varin:browser:${identity.ownerGeneration}`) throw new Error('Browser owner public identity proof does not match');
    const key = createPublicKey({ key: publicKey, type: 'spki', format: 'der' });
    if (key.asymmetricKeyType !== 'ed25519' || !verify(null, Buffer.from(JSON.stringify([this.hostId, challenge.challenge])), key, Buffer.from(text(input.signature), 'base64'))) throw new Error('Browser owner signature is invalid');
    const old = this.devices.get(identity.browserId);
    if (old?.device.state === 'connected') throw new Error('The original Browser owner already has an active connection');
    const grantId = randomUUID(), controlToken = randomBytes(32).toString('base64url'), mediaToken = randomBytes(32).toString('base64url');
    this.grants.set(grantId, { identity: { ...identity, hostId: this.hostId, grantId }, principalId, controlToken, mediaToken, expires: Date.now() + 60_000, used: false });
    return { hostId: this.hostId, grantId, controlToken, mediaToken };
  }
  admitSocket(principalId: string, lane: 'control' | 'media', token: string): (socket: WebSocket) => void {
    const grant = [...this.grants.values()].find(grant => grant.principalId === principalId && (lane === 'control' ? grant.controlToken : grant.mediaToken) === token);
    if (!grant || grant.used || grant.expires <= Date.now() || grant[lane]) throw new Error('Browser device grant is missing, stale, already used or belongs to another authenticated client');
    // Consume before asynchronous upgrade: duplicate upgrades cannot race.
    if (lane === 'control') grant.controlToken = ''; else grant.mediaToken = '';
    return socket => {
      grant[lane] = socket;
      if (!grant.control || !grant.media) return;
      grant.used = true; this.grants.delete(grant.identity.grantId);
      const wire = new BrowserDeviceWire(grant.control, grant.media);
      const device: BrowserDevice = { ...grant.identity, local: false, state: 'connected' };
      const owner = new RemoteBrowserOwner(grant.identity, wire, () => { device.state = 'disconnected'; device.error = 'The original Browser device is unavailable. Its previous effects have not been replayed.'; this.retired.set(grant.identity.grantId, owner); }, receipt => {
        const original = this.retired.get(receipt.originalGrantId);
        if (!original) throw new Error('Recovered Browser stop has no original grant');
        if (['hostId', 'deviceId', 'browserId', 'ownerGeneration'].some(key => original.grant[key as keyof BrowserDeviceGrant] !== grant.identity[key as keyof BrowserDeviceGrant])) throw new Error('Recovered Browser stop belongs to another original owner');
        original.recoverStop(receipt.requestId, receipt.leaseId);
      });
      try { this.add(device, owner); }
      catch { wire.close(); return; }
      void wire.send({ kind: 'connected', hostId: this.hostId, grantId: grant.identity.grantId }).catch(() => wire.close());
    };
  }
  async catalog(): Promise<BrowserCatalog> { return { hostId: this.hostId, devices: [...this.devices.values()].map(value => ({ ...value.device })), defaultBrowserId: this.selected, pages: await this.list() }; }
  select(browserId: string | null) {
    if (browserId && this.devices.get(browserId)?.device.state !== 'connected') throw new Error('Select a connected original Browser device');
    this.selected = browserId;
  }
  async revoke(browserId: string) {
    const entry = this.devices.get(browserId);
    if (!entry || !(entry.owner instanceof RemoteBrowserOwner)) throw new Error('This is not a delegated Browser device');
    entry.device.state = 'revoking';
    await entry.owner.revoke(); entry.device.state = 'disconnected';
    if (this.selected === browserId) this.selected = null;
  }
  private connected(browserId: string): Registered {
    const entry = this.devices.get(browserId);
    if (!entry || entry.device.state !== 'connected') throw new BrowserExecutionError('The original Browser device is unavailable; no local replacement was created', 'none');
    return entry;
  }
  async owner(pageId: string): Promise<BrowserOwner> {
    if (!this.pageOwners.has(pageId)) await this.list();
    const browserId = this.pageOwners.get(pageId);
    if (!browserId) throw new BrowserExecutionError('browser_page_unknown: Select an existing page on its original Browser device', 'none');
    return this.connected(browserId).owner;
  }
  async list(): Promise<BrowserPage[]> {
    await Promise.all([...this.devices.values()].map(async entry => {
      if (entry.device.state !== 'connected') return;
      try { const pages = await entry.owner.list(); entry.pages.clear(); for (const page of pages) this.remember(entry, page); }
      catch (error) { if (entry.owner instanceof RemoteBrowserOwner && !entry.owner.connected) return; throw error; }
    }));
    return [...this.devices.values()].flatMap(entry => [...entry.pages.values()].map(page => entry.device.state === 'connected' ? page : { ...page, crashed: entry.device.error ?? 'The original Browser device is unavailable' }));
  }
  async open(input: { url: string; pageId?: string; retained?: boolean }, scope: { threadId?: string; signal?: AbortSignal } = {}): Promise<BrowserPage> {
    const pinned = scope.threadId ? this.threadOwners.get(scope.threadId) : undefined;
    const owner = input.pageId ? await this.owner(input.pageId) : this.connected(pinned ?? this.selected ?? '').owner;
    const page = await owner.open(input, scope), entry = this.connected(owner.browserId); this.remember(entry, page);
    if (scope.threadId) this.threadOwners.set(scope.threadId, owner.browserId); return page;
  }
  async read(input: BrowserReadRequest, signal?: AbortSignal): Promise<BrowserObservation> { return (await this.owner(input.pageId)).read(input, signal); }
  async act(pageId: string, action: BrowserAction, signal?: AbortSignal) { return (await this.owner(pageId)).act(pageId, action, signal); }
  async userAction(pageId: string, action: BrowserAction) {
    const owner = await this.owner(pageId) as BrowserOwner & { act(pageId: string, action: BrowserAction, signal?: AbortSignal, user?: boolean): Promise<import('@varin/protocol').BrowserActionResult> };
    return owner.act(pageId, action, undefined, true);
  }
  async downloads(pageId: string): Promise<BrowserDownload[]> { return (await this.owner(pageId)).downloads(pageId); }
  async readDownload(pageId: string, downloadId: string, signal?: AbortSignal) { return (await this.owner(pageId)).readDownload(pageId, downloadId, signal); }
  async releaseDownload(pageId: string, downloadId: string) { return (await this.owner(pageId)).releaseDownload(pageId, downloadId); }
  async upload(pageId: string, ref: string, files: { name: string; bytes: Uint8Array }[], signal?: AbortSignal) { return (await this.owner(pageId)).upload(pageId, ref, files, signal); }
  async retainForThread(pageId: string, threadId: string) {
    const owner = await this.owner(pageId); await owner.retainForThread(pageId, threadId); this.threadOwners.set(threadId, owner.browserId);
  }
  async releaseThread(threadId: string) {
    await Promise.all([...this.devices.values()].map(entry => entry.owner.releaseThread(threadId))); this.threadOwners.delete(threadId);
  }
  subscribe(listener: (event: BrowserEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  assertViewer(pageId: string, streamId: string) {
    const actor = browserActor.getStore(), view = this.viewers.get(streamId);
    if (actor?.kind !== 'user' || !view || view.pageId !== pageId || view.principalId !== actor.principalId) throw new BrowserExecutionError('This browser view belongs to another original authenticated user', 'none');
  }
  async assertChooser(pageId: string, chooserId: string) {
    const owner = await this.owner(pageId), page = (await owner.list()).find(page => page.pageId === pageId);
    if (!page?.controlViewerId || page.fileChooser?.chooserId !== chooserId) throw new Error('This file chooser has no current human control lease');
    this.assertViewer(pageId, page.controlViewerId);
  }
  async subscribeFrames(pageId: string, streamId: string, listener: (frame: BrowserFrame) => void) {
    const actor = browserActor.getStore();
    if (actor?.kind !== 'user' || this.viewers.has(streamId)) throw new Error('Browser stream requires a unique authenticated viewer');
    this.viewers.set(streamId, { pageId, principalId: actor.principalId });
    try {
      const stop = await presentationOwner(await this.owner(pageId)).subscribeFrames(pageId, streamId, listener);
      return async () => { await stop(); this.viewers.delete(streamId); };
    } catch (error) { this.viewers.delete(streamId); throw error; }
  }
  async clipboard(input: BrowserClipboardRequest) { this.assertViewer(input.pageId, input.streamId); return presentationOwner(await this.owner(input.pageId)).clipboard(input); }
  async input(input: BrowserInputRequest) { this.assertViewer(input.pageId, input.streamId); return presentationOwner(await this.owner(input.pageId)).input(input); }
  stop() { for (const grant of this.grants.values()) { grant.control?.terminate(); grant.media?.terminate(); } this.grants.clear(); for (const entry of this.devices.values()) { entry.releaseEvents(); if (entry.owner instanceof RemoteBrowserOwner) entry.owner.closeTransport(); } }
}
