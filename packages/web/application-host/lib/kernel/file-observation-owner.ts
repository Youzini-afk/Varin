import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { DocumentAuthority } from '../documents/authority.js';
import { createWorkspaceWatcher, type WorkspaceWatcher, type WatchEvent } from '../documents/watch.js';
import type { CaptureToken } from '../documents/mutation-authority.js';
import { canonicalizePathIdentity } from '../workspace/path-safety.js';
import type { LiveSourceResolver } from './live-source.js';
import type { FileObservationOwnerQuery, FileObservationOwnerResult, FileObservationOwnerHint,
  FileObservationTarget, FileWatchPosition } from './protocol.generated.js';

export interface FileObservationOwner {
  query(query: FileObservationOwnerQuery, signal: AbortSignal): Promise<FileObservationOwnerResult>;
  invalidate(hint: FileObservationOwnerHint): void;
  reset(): void;
}
interface Subscription {
  readonly position: FileWatchPosition | null;
  ready: Promise<boolean>;
  settle(): Promise<void>;
  close(): void;
}
interface ReadToken { position: FileWatchPosition; capture?: CaptureToken }
interface Watch {
  id: string;
  target: FileObservationTarget;
  subscription: Subscription;
  latestTarget: FileWatchPosition | null;
  tokens: Map<string, ReadToken>;
}
interface RootWatch { controller: WorkspaceWatcher; listeners: Set<(event: WatchEvent) => void> }
const samePosition = (a: FileWatchPosition, b: FileWatchPosition) => a.sourceId === b.sourceId
  && a.generation === b.generation && a.sequence === b.sequence;
const sameSource = (a: FileWatchPosition, b: FileWatchPosition) => a.sourceId === b.sourceId && a.generation === b.generation;
function failed(code: string): never { throw Object.assign(new Error(code), { code }); }

/** Only transient watches/read tokens live here. Catalog owns all conditions and accepted
 * cursors; Storage owns root/path authority and snapshots. No timer evaluates conditions. */
export class DocumentsFileObservationOwner implements FileObservationOwner {
  private readonly watches = new Map<string, Watch>();
  private readonly roots = new Map<string, RootWatch>();
  private generation = 0;
  private readonly unsubscribe: () => void;
  constructor(private readonly documents: DocumentAuthority,
    private readonly validateLiveSource: LiveSourceResolver,
    private readonly changed: (receiptId: string) => void) {
    this.unsubscribe = documents.subscribeMutationState(workspaceId => {
      for (const watch of this.watches.values()) if (watch.target.source.mode === 'live_root'
        && watch.target.source.workspace_id === workspaceId) this.changed(watch.target.receiptId);
    });
  }
  has(receiptId: string, watchId: string | null): boolean {
    const watch = watchId ? this.watches.get(watchId) : undefined;
    return watch !== undefined && watch.target.receiptId === receiptId;
  }
  invalidate(hint: FileObservationOwnerHint): void {
    if (hint.scope === 'receipt') { this.changed(hint.receiptId); return; }
    for (const watch of this.watches.values()) if (watch.target.physicalRoot?.rootId === hint.rootId
      && watch.target.physicalRoot.canonicalRoot === hint.canonicalRoot) this.changed(watch.target.receiptId);
  }
  private async validate(target: FileObservationTarget, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const root = target.physicalRoot;
    if (target.immutable || !root || root.hostId !== this.documents.hostId) failed('root_changed');
    if (target.source.mode === 'live_root') {
      if (!target.source.live_root || !isDeepStrictEqual(root, target.source.live_root)) failed('root_changed');
      await this.validateLiveSource({ workspaceId: target.source.workspace_id,
        executionWorkspaceId: target.source.execution_workspace_id, liveRoot: root }, signal);
    } else if (target.source.mode !== 'materialized') failed('root_changed');
    if (await canonicalizePathIdentity(root.canonicalRoot) !== root.canonicalRoot) failed('root_changed');
    if (!(await fs.promises.stat(root.canonicalRoot)).isDirectory()) failed('source_unavailable');
    signal.throwIfAborted();
  }
  private managedWatch(target: FileObservationTarget, listener: (event: WatchEvent) => void): Subscription {
    const root = target.physicalRoot!.canonicalRoot;
    let owner = this.roots.get(root);
    if (!owner) {
      const listeners = new Set<(event: WatchEvent) => void>();
      const controller = createWorkspaceWatcher({ workspaceId: target.source.execution_workspace_id, rootPath: root,
        fsModule: fs, fsPromises: fs.promises, pathModule: path,
        onEvent: event => { for (const consume of listeners) consume(event); } });
      owner = { controller, listeners }; this.roots.set(root, owner);
    }
    const selected = owner;
    selected.listeners.add(listener);
    return { ready: Promise.resolve(true), get position() { return selected.controller.position; },
      settle: () => selected.controller.settle(), close: () => {
        selected.listeners.delete(listener);
        if (!selected.listeners.size) { selected.controller.close(); if (this.roots.get(root) === selected) this.roots.delete(root); }
      } };
  }
  private async open(target: FileObservationTarget, signal: AbortSignal): Promise<Watch> {
    const generation = this.generation;
    const work = (async () => {
      await this.validate(target, signal);
      const watchId = randomUUID();
      const receive = (event: WatchEvent) => {
        const watch = this.watches.get(watchId);
        if (!watch) return;
        if (event.kind === 'reset') watch.latestTarget = null;
        const resource = event.resource?.resourceId;
        if (resource === target.path) watch.latestTarget = { sourceId: event.sourceId, generation: event.generation, sequence: event.sequence };
        if (event.kind === 'reset' || resource === target.path || (resource && target.path.startsWith(`${resource}/`))) this.changed(target.receiptId);
      };
      const subscription = target.source.mode === 'live_root'
        ? this.documents.watch(target.source.workspace_id, receive) : this.managedWatch(target, receive);
      const watch: Watch = { id: watchId, target: structuredClone(target), subscription, latestTarget: null, tokens: new Map() };
      try {
        if (!await subscription.ready) failed('watch_unavailable');
        await this.validate(target, signal);
        if (generation !== this.generation) failed('cancelled');
        this.watches.set(watch.id, watch);
        return watch;
      } catch (error) { subscription.close(); throw error; }
    })();
    return work;
  }
  private bound(receiptId: string, watchId: string, target?: FileObservationTarget): Watch {
    const watch = this.watches.get(watchId);
    if (!watch || watch.target.receiptId !== receiptId) failed('watch_unavailable');
    if (target && !isDeepStrictEqual(watch.target, target)) failed('root_changed');
    return watch;
  }
  private discard(watch: Watch, token: string): boolean {
    const read = watch.tokens.get(token);
    if (!read) return false;
    watch.tokens.delete(token);
    if (read.capture) this.documents.discardCapture(read.capture);
    return true;
  }
  private close(watch: Watch): void {
    for (const token of watch.tokens.keys()) this.discard(watch, token);
    watch.subscription.close();
    if (this.watches.get(watch.id) === watch) this.watches.delete(watch.id);
  }
  reset(): void {
    this.generation += 1;
    for (const watch of this.watches.values()) this.close(watch);
  }
  stop(): void { this.reset(); this.unsubscribe(); }
  async query(query: FileObservationOwnerQuery, signal: AbortSignal): Promise<FileObservationOwnerResult> {
    try {
      signal.throwIfAborted();
      if (query.action === 'close') {
        const watch = this.watches.get(query.watchId);
        if (watch?.target.receiptId === query.receiptId) this.close(watch);
        return { ok: true, closed: true };
      }
      if (query.action === 'discard') {
        const watch = this.watches.get(query.watchId);
        return { ok: true, discarded: watch?.target.receiptId === query.receiptId ? this.discard(watch, query.token) : false };
      }
      if (query.action === 'open') {
        const watch = await this.open(query.target, signal);
        const position = watch.subscription.position;
        if (!position) failed('watch_unavailable');
        return { ok: true, watchId: watch.id, position };
      }
      const watch = this.bound(query.target.receiptId, query.watchId, query.target);
      await this.validate(watch.target, signal);
      // Give already queued OS notifications a chance to enter the original watcher,
      // then drain its existing coalescing batch. This is not a quiet-period timer.
      await new Promise<void>(resolve => setImmediate(resolve));
      await watch.subscription.settle();
      signal.throwIfAborted();
      if (query.action === 'begin') {
        const capture = watch.target.source.mode === 'live_root'
          ? await this.documents.beginCapture(watch.target.source.workspace_id, {}, signal) : undefined;
        try {
          signal.throwIfAborted();
          this.bound(query.target.receiptId, query.watchId, query.target);
          const position = watch.subscription.position;
          if (!position) failed('watch_unavailable');
          const token = randomUUID(); watch.tokens.set(token, { position, ...(capture ? { capture } : {}) });
          return { ok: true, token, position };
        } catch (error) { if (capture) this.documents.discardCapture(capture); throw error; }
      }
      const read = watch.tokens.get(query.token);
      if (!read) failed('watch_unavailable');
      try {
        const capture = read.capture ? await this.documents.completeCapture(read.capture, signal) : undefined;
        await this.validate(watch.target, signal);
        this.bound(query.target.receiptId, query.watchId, query.target);
        const position = watch.subscription.position;
        if (!position) failed('watch_unavailable');
        const after = query.after ?? read.position;
        const gap = !sameSource(after, position) || after.sequence > position.sequence;
        const targetedChange = !gap && watch.latestTarget !== null && sameSource(watch.latestTarget, after)
          && watch.latestTarget.sequence > after.sequence;
        return { ok: true, position, gap, targetedChange,
          // A persistent managed writer is a readiness fact, not proof that this read changed.
          stable: samePosition(read.position, position) && (capture?.reasons.every(reason => reason === 'active-writer' || reason === 'maintenance') ?? true),
          managedIdle: !capture || (!capture.state.maintenance && capture.state.activeWriters.length === 0) };
      } finally { this.discard(watch, query.token); }
    } catch (error) {
      if (query.action === 'finish') {
        const watch = this.watches.get(query.watchId);
        if (watch?.target.receiptId === query.target.receiptId) this.discard(watch, query.token);
      }
      const code = (error as { code?: string }).code;
      const failure = signal.aborted ? 'cancelled' : ['untrusted', 'path-escape', 'forbidden'].includes(code ?? '')
        ? 'authority_denied' : ['root_changed', 'watch_unavailable', 'cancelled', 'authority_denied'].includes(code ?? '') ? code! : 'source_unavailable';
      if ((query.action === 'begin' || query.action === 'finish') && ['authority_denied', 'source_unavailable', 'root_changed'].includes(failure)) {
        const watch = this.watches.get(query.watchId);
        if (watch && isDeepStrictEqual(watch.target, query.target)) this.close(watch);
      }
      return { ok: false, code: failure };
    }
  }
}
