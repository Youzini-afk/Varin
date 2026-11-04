/** Shell-independent desktop companion owner. The private native port owns only
 * windows; artwork, scene chronology, gestures and settings retain one owner. */
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { readFile, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createSettingsFileStore } from '@varin/settings-store';
import { CompanionAssets, readCompanionAssetCatalog } from './assets.js';
import { CompanionWindowMovement, CompanionWindowPresentation, applyCompanionPassthrough, captureCompanionPlacement, restoreCompanionPlacement, companionWorldRect, type CompanionDisplay } from './window.js';
import { CompanionSceneWindows, readCompanionSceneDescriptor, type CompanionScenePayload, type CompanionSceneViewport } from './scene.js';
import { CompanionStoolWindows } from './stool.js';
import type { DesktopNativePort } from '../platform/desktop-host-session.js';
type Bounds = { x: number; y: number; width: number; height: number };
type NativeState = { revision: number; id: number; label: string; bounds: Bounds; contentBounds: Bounds; visible: boolean; minimized: boolean; alwaysOnTop: boolean; destroyed: boolean };
const object = (value: unknown): Record<string, unknown> => { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid companion native receipt'); return value as Record<string, unknown>; };
const bounds = (value: unknown): Bounds => { const v = object(value); if (!['x','y','width','height'].every(k => typeof v[k] === 'number' && Number.isFinite(v[k])) || Number(v.width) <= 0 || Number(v.height) <= 0) throw new Error('Invalid companion native geometry'); return { x: Number(v.x), y: Number(v.y), width: Number(v.width), height: Number(v.height) }; };
function nativeState(value: unknown): NativeState { const v = object(value); if (!Number.isSafeInteger(v.revision) || Number(v.revision)<0 || !Number.isSafeInteger(v.id) || typeof v.label !== 'string' || !['visible','minimized','alwaysOnTop','destroyed'].every(k => typeof v[k] === 'boolean')) throw new Error('Invalid companion native window'); return { revision: Number(v.revision), id: Number(v.id), label: v.label, bounds: bounds(v.bounds), contentBounds: bounds(v.contentBounds), visible: v.visible as boolean, minimized: v.minimized as boolean, alwaysOnTop: v.alwaysOnTop as boolean, destroyed: v.destroyed as boolean }; }

class NativeCompanionWindow extends EventEmitter {
  readonly webContents = new EventEmitter();
  private pending: Promise<unknown>;
  private failure: unknown;
  private closing?: Promise<void>;
  private readonly created: Promise<unknown>;
  constructor(readonly id: number, readonly role: 'companion'|'scene'|'stool', public state: NativeState, private readonly port: DesktopNativePort, creation: Promise<unknown>) {
    super(); this.created = creation.then(value => { this.accept(value); }); this.pending = this.created; this.observe(this.pending);
  }
  accept(value: unknown) { const next = nativeState(value); if (!this.state.destroyed && next.revision >= this.state.revision) this.state = next; }
  private observe(promise: Promise<unknown>) { void promise.catch(error => { this.failure ??= error; this.webContents.emit('render-process-gone'); }); }
  command(method: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const result = this.pending.then(() => { if (this.failure) throw this.failure; if (this.closing) throw new Error('Companion window is closing'); return this.port.request(method, { id: this.id, ...args }); });
    this.pending = result; this.observe(result); return result;
  }
  waitForCreation = () => this.created;
  async flush() { await this.pending; if (this.failure) throw this.failure; }
  isDestroyed = () => this.state.destroyed;
  isVisible = () => this.state.visible;
  isMinimized = () => this.state.minimized;
  isAlwaysOnTop = () => this.state.alwaysOnTop;
  getBounds = () => ({ ...this.state.bounds });
  getContentBounds = () => ({ ...this.state.contentBounds });
  update(input: Record<string, unknown>) { void this.command('companion.update', input).then(value => { this.accept(value); }).catch(() => {}); }
  showInactive = () => this.update({ visible: true });
  hide = () => this.update({ visible: false });
  setAlwaysOnTop = (alwaysOnTop: boolean) => this.update({ alwaysOnTop });
  setBounds = (value: Bounds) => this.update({ bounds: value });
  setPosition = (x: number, y: number) => this.setBounds({ ...this.state.bounds, x, y });
  setIgnoreMouseEvents = (passthrough: boolean) => this.update({ passthrough });
  close = () => { void this.closeConfirmed().catch(() => {}); };
  destroy = this.close;
  closeConfirmed(): Promise<void> {
    return this.closing ??= (async () => { await this.created.catch(() => {}); await this.port.request('companion.close', { id: this.id }); this.closed(); })();
  }
  closed() { if (this.state.destroyed) return; this.state = { ...this.state, destroyed: true, visible: false }; this.emit('closed'); }
  onReady = (callback: () => void) => { void this.command('companion.ready').then(() => callback()).catch(() => {}); };
  onRendererGone = (callback: () => void) => { this.webContents.on('render-process-gone', callback); };
  publish = async (payload: CompanionScenePayload) => { await this.command('companion.publish', { payload }); };
}

export function createNativeShellCompanionOwner(options: { port: DesktopNativePort; dataDirectory: string; frontendDirectory: string; fetch?: typeof fetch }) {
  const { port } = options;
  const store = createSettingsFileStore({ filePath: path.join(options.dataDirectory, 'settings.json') });
  const windows = new Map<number, NativeCompanionWindow>();
  const origins = new Map<number, Bounds>();
  const presentation = new CompanionWindowPresentation();
  let nextId = 0, companion: NativeCompanionWindow | undefined;
  let displays: CompanionDisplay[] = [], primaryId = 0, platform = '', cursor = { x: 0, y: 0 };
  let assets: CompanionAssets | undefined, assetStart: Promise<CompanionAssets> | undefined;
  let controls: Promise<unknown> = Promise.resolve();
  let connected = true, stopping = false;
  let placementWrite: Promise<void> = Promise.resolve();
  const listeners = new Set<() => void>();
  const changed = () => { for (const listener of listeners) { try { listener(); } catch { /* Observers do not own native state. */ } } };
  const serialized = <T>(operation: () => Promise<T>): Promise<T> => { const result = controls.then(operation, operation); controls = result.catch(() => {}); return result; };
  const selected = (): string | null => { const value = store.readSync().desktopCompanionPackId; return value === null ? null : typeof value === 'string' ? assets?.get(value) ? value : null : assets?.list().find(p => p.installedVersion)?.id ?? null; };
  const area = (value: Bounds) => {
    if (!displays.length) throw new Error('Companion native display geometry is unavailable');
    const overlap = (d: CompanionDisplay) => Math.max(0, Math.min(value.x+value.width,d.workArea.x+d.workArea.width)-Math.max(value.x,d.workArea.x)) * Math.max(0, Math.min(value.y+value.height,d.workArea.y+d.workArea.height)-Math.max(value.y,d.workArea.y));
    return [...displays].sort((a,b) => overlap(b)-overlap(a))[0]!;
  };
  const movement = new CompanionWindowMovement(value => area(value).workArea);
  const refresh = async () => {
    const value = object(await port.request('companion.snapshot', {}));
    if (!Array.isArray(value.windows) || !Array.isArray(value.displays) || !Number.isSafeInteger(value.primaryId) || typeof value.platform !== 'string') throw new Error('Invalid companion display snapshot');
    displays = value.displays.map(raw => { const d = object(raw); if (!Number.isSafeInteger(d.id)) throw new Error('Invalid companion display'); return { id: Number(d.id), workArea: bounds(d.workArea) }; });
    primaryId = Number(value.primaryId); platform = value.platform;
    const point = object(value.cursor); if (typeof point.x !== 'number' || typeof point.y !== 'number' || !Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error('Invalid native cursor'); cursor = { x: point.x, y: point.y };
    for (const raw of value.windows) { const state = nativeState(raw); const existing = windows.get(state.id); if (existing) existing.accept(state); }
  };
  const persist = (owner: NativeCompanionWindow): Promise<void> => { if (owner.isDestroyed()) return placementWrite; const placement = captureCompanionPlacement(owner.getBounds(), area(owner.getBounds())); const write = placementWrite.then(async () => { await store.update(root => { root.desktopCompanionPlacement = placement; }); }); placementWrite = write.catch(() => {}); return write; };
  const create = (role: 'companion'|'scene'|'stool', rect: Bounds, owner?: { id: number }, phase?: string) => {
    if (stopping || !connected) throw new Error('Companion owner is stopping');
    const packId = selected(), pack = packId ? assets?.get(packId) : undefined;
    if (!pack) throw new Error('Download a companion in Settings → Desktop companion before waking it');
    const id = ++nextId;
    const window = new NativeCompanionWindow(id, role, { id, revision: 0, label: '', bounds: rect, contentBounds: rect, visible: false, minimized: false, alwaysOnTop: false, destroyed: false }, port,
      port.request('companion.create', { id, role, bounds: rect, pack: { id: pack.id, version: pack.version }, ...(owner ? { ownerId: owner.id } : {}), ...(phase ? { phase } : {}) }));
    windows.set(id, window);
    window.once('closed', () => { windows.delete(id); if (role === 'companion') { movement.forget(id); origins.delete(id); scenes.clear(id); stools.clear(id); if (companion === window) companion = undefined; changed(); } });
    return window;
  };
  const scenes = new CompanionSceneWindows((rect, owner) => create('scene',rect,owner), value => area(value).workArea);
  const stools = new CompanionStoolWindows((rect, phase, owner) => {
    const window = create('stool',rect,owner,phase);
    return { isDestroyed: window.isDestroyed, close: window.close, onReady(callback: () => void) { window.onReady(() => { void window.command('companion.stoolVisible').then(callback).catch(() => window.close()); }); } };
  });
  const closeAll = async () => { scenes.clearAll(); stools.clearAll(); const current = [...windows.values()]; await Promise.all(current.map(window => window.closeConfirmed())); };
  const ensureAssets = () => assetStart ??= (async () => {
    const catalog = readCompanionAssetCatalog(JSON.parse(await readFile(path.join(options.frontendDirectory,'companion-catalog.json'),'utf8')));
    const result = new CompanionAssets({ root: path.join(options.dataDirectory,'companions'), catalog, fetch: options.fetch ?? fetch, changed,
      beforeReplace: async id => { if (selected() === id) await closeAll(); },
      afterReplace: id => { void serialized(async () => { if (store.readSync().desktopCompanionEnabled === true && selected() === id) await wake(); }).catch(() => {}); },
    });
    await result.initialize(); assets = result; return result;
  })().catch(error => { assetStart = undefined; throw error; });
  const wake = async () => {
    if (companion && !companion.isDestroyed()) { await presentation.wait(companion); companion.showInactive(); await companion.flush(); return; }
    await refresh();
    const rect = restoreCompanionPlacement(store.readSync().desktopCompanionPlacement,{ width:360,height:480 },displays,primaryId) ?? { x:displays[0]!.workArea.x,y:displays[0]!.workArea.y,width:360,height:480 };
    const owner = create('companion',rect); companion = owner;
    await presentation.wait(owner); await owner.flush();
  };
  const status = () => ({ enabled: store.readSync().desktopCompanionEnabled === true, visible: companion?.isVisible() === true && !companion.isDestroyed() });
  const requireOwner = async (label: unknown) => {
    const owner = companion;
    if (!owner || owner.isDestroyed()) throw new Error('This command belongs only to the companion sender window');
    // A fast native document can present before its create reply is consumed.
    // Only that original receipt supplies the label; never infer it from Node ids.
    await owner.waitForCreation();
    if (stopping || !connected || companion !== owner || owner.isDestroyed() || label !== owner.state.label) throw new Error('This command belongs only to the companion sender window');
    return owner;
  };
  const unsubscribe = port.subscribe((event, raw) => {
    if (event === 'companion.native.disconnected') { connected = false; for (const window of windows.values()) window.webContents.emit('render-process-gone'); return; }
    if (event !== 'companion.native') return;
    const value = object(raw), window = windows.get(Number(value.id));
    if (value.kind === 'displays') { void refresh().then(async () => { if (!companion) return; if (movement.isDragging(companion.id)) { scenes.refresh(companion.id); return; } const rect = restoreCompanionPlacement(store.readSync().desktopCompanionPlacement,companion.getBounds(),displays,primaryId); if (rect) { movement.forget(companion.id); stools.clear(companion.id); origins.delete(companion.id); companion.setBounds(rect); await companion.flush(); scenes.refresh(companion.id); await persist(companion); } }).catch(() => {}); return; }
    if (!window) return;
    if (value.kind === 'closed') { if (window.role === 'companion') void persist(window).catch(() => {}); window.closed(); return; }
    if (value.kind === 'crashed') { window.webContents.emit('render-process-gone'); return; }
    if (value.kind === 'state') { window.accept(value.state); if (window.role === 'companion') { scenes.refresh(window.id); if (value.blur === true) { movement.forget(window.id); origins.delete(window.id); stools.clear(window.id); window.setIgnoreMouseEvents(false); } } }
  });
  const invoke = async (input: unknown): Promise<unknown> => {
    if (stopping) throw new Error('Companion owner is stopping');
    if (!connected) throw new Error('Companion native transport disconnected; prior effects are unknown');
    const request = object(input), args = request.args === undefined ? {} : object(request.args);
    switch (request.command) {
      case 'desktop_get_companion': return status();
      case 'desktop_companion_library': {
        const operation = async () => { const library = await ensureAssets(), id = args.id;
          if (args.action !== 'list' && typeof id !== 'string') throw new Error('Companion identity is required');
          switch (args.action) {
            case 'list': break;
            case 'download': library.start(id as string); break;
            case 'cancel': await library.cancel(id as string); break;
            case 'remove': if (selected() === id) { await closeAll(); await store.update(root => { root.desktopCompanionEnabled=false;root.desktopCompanionPackId=null; }); } await library.remove(id as string); break;
            case 'select': await library.ready(id as string); if (!library.get(id as string)) throw new Error('Companion artwork is not installed'); await closeAll(); await store.update(root => {root.desktopCompanionPackId=id;}); if (store.readSync().desktopCompanionEnabled === true) await wake(); break;
            default: throw new Error('Unknown companion library action');
          } if (args.action !== 'list') changed(); return { ...status(),selectedPackId:selected(),packs:library.list() }; };
        return args.action === 'list' ? operation() : serialized(operation);
      }
      case 'desktop_set_companion': return serialized(async () => { if (typeof args.enabled !== 'boolean') throw new Error('Companion requires an explicit boolean'); if (args.enabled) { const library=await ensureAssets(); await library.ready(selected()); await wake(); } else await closeAll(); await store.update(root => {root.desktopCompanionEnabled=args.enabled;}); changed();return status(); });
      case 'desktop_get_window_pinned': { const owner = await requireOwner(request.windowLabel); await refresh(); return { pinned: owner.isAlwaysOnTop() }; }
      case 'desktop_set_window_pinned': {
        const owner = await requireOwner(request.windowLabel);
        if (typeof args.pinned !== 'boolean') throw new Error('Pinned state requires an explicit boolean');
        owner.setAlwaysOnTop(args.pinned);
        await owner.flush();
        scenes.refresh(owner.id);
        return { pinned: owner.isAlwaysOnTop() };
      }
      case 'desktop_companion_presented': { const owner=await requireOwner(request.windowLabel); if (args.status==='ready') presentation.presented(owner); else if (args.status==='failed' && typeof args.message==='string') presentation.fail(owner,args.message); else throw new Error('Invalid companion presentation result'); await owner.flush(); changed(); return null; }
      case 'desktop_companion_scene': { const owner=await requireOwner(request.windowLabel); const descriptor=readCompanionSceneDescriptor(args.descriptor); if (descriptor.drawing?.bundle==='review') throw new Error('Review drawing requires explicit developer review'); scenes.update(owner,descriptor,args.viewport as CompanionSceneViewport);scenes.block(owner.id,movement.isDragging(owner.id));return scenes.inspectionReceipt(owner.id); }
      case 'desktop_companion_stool': { const owner=await requireOwner(request.windowLabel); if (args.phase==='clear') {stools.clear(owner.id);return null;} if (args.phase!=='lift' && args.phase!=='landing') throw new Error('Invalid world stool phase'); const origin=args.phase==='lift' ? origins.get(owner.id) ?? owner.getContentBounds() : owner.getContentBounds();stools.show(owner,companionWorldRect(origin,args.viewport),args.phase); return null; }
      case 'desktop_companion_drag': { const owner=await requireOwner(request.windowLabel);await refresh();const origin=args.phase==='start' ? owner.getContentBounds() : null, wasDragging=movement.isDragging(owner.id);movement.drag(owner,{phase:args.phase,anchor:args.anchor,screenX:cursor.x,screenY:cursor.y}); if (origin) {origins.set(owner.id,origin);scenes.block(owner.id,true);} await owner.flush();if(args.phase==='end' && wasDragging) await persist(owner); return null; }
      case 'desktop_companion_passthrough': { const owner=await requireOwner(request.windowLabel);const result=applyCompanionPassthrough(owner,args.enabled,platform,movement.isDragging(owner.id));await owner.flush();return result; }
      default: throw new Error('Unknown desktop companion command');
    }
  };
  return { invoke, subscribe(listener: () => void) {listeners.add(listener);return () => {listeners.delete(listener);};},
    async asset(input: unknown) {
      const request=object(input); if(typeof request.path!=='string') throw new Error('Companion asset path is required');
      const library=await ensureAssets(),file=await library.resolve(request.path);if(!file)throw new Error('Companion asset is not installed');
      const [id,,name]=request.path.split('/');const expected=id ? library.get(id)?.files.find(item=>item.path===name) : undefined;
      if(!expected)throw new Error('Companion artwork is not in its installed catalog');
      const handle=await open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
      try {
        const info=await handle.stat();if(!info.isFile()||info.size!==expected.bytes)throw new Error('Companion artwork length changed');
        const bytes=Buffer.alloc(expected.bytes);let offset=0;
        while(offset<bytes.length){const {bytesRead}=await handle.read(bytes,offset,bytes.length-offset,null);if(!bytesRead)break;offset+=bytesRead;}
        const trailing=await handle.read(Buffer.alloc(1),0,1,null);
        const digest=createHash('sha256').update(bytes).digest('hex');
        if(offset!==expected.bytes||trailing.bytesRead||expected.sha256!==digest)throw new Error('Companion artwork integrity check failed');
        return{file,size:info.size,sha256:digest,mime:file.endsWith('.png')?'image/png':'application/json'};
      } finally {await handle.close();}
    },
    async dispose() {
      stopping=true;
      await assetStart?.catch(()=>{});
      if(assets)await Promise.all(assets.list().map(pack=>assets!.cancel(pack.id)));
      await closeAll();await placementWrite;
      unsubscribe();listeners.clear();
    },
  };
}
