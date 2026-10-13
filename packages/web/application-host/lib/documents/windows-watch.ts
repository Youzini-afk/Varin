/** One private process multiplexes Windows directory subscriptions. It owns only
 * OS notification handles; Documents still owns revisions and capture decisions. */
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { prepareKernelCommand } from '../kernel/kernel-launch.js';
import type { NativeWatcher } from './watch.js';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}
const asError = (error: unknown) => error instanceof Error ? error : new Error(String(error));
type Frame = { v: number; kind: string; id?: string; request?: string; message?: string; events?: Array<{ kind: string; path?: string }> };

class DirectoryWatch extends EventEmitter implements NativeWatcher {
  readonly id = randomUUID();
  private readonly opening = deferred<void>();
  readonly ready = this.opening.promise;
  private readonly flushes = new Map<string, ReturnType<typeof deferred<void>>>();
  private closed = false;
  private attached = false;
  get connected() { return this.attached && !this.closed; }
  get pending() { return !this.attached || this.flushes.size > 0; }
  constructor(readonly manager: WatchProcess, readonly path: string,
    readonly changed: (event: string, filename: string | null) => void) { super(); }
  receive(frame: Frame) {
    if (this.closed) return;
    if (frame.kind === 'ready') { this.attached = true; this.opening.resolve(); }
    else if (frame.kind === 'events') {
      if (!this.attached || !Array.isArray(frame.events)) throw new Error('Directory notification arrived without its subscription');
      for (const event of frame.events) {
        if (event.kind === 'reset') this.changed('change', null);
        else if (['change', 'rename', 'content'].includes(event.kind) && typeof event.path === 'string') this.changed(event.kind, event.path);
        else throw new Error('Invalid Windows directory notification');
      }
    } else if (frame.kind === 'flushed' && typeof frame.request === 'string') {
      const pending = this.flushes.get(frame.request);
      this.flushes.delete(frame.request); pending?.resolve();
    } else if (frame.kind === 'error') this.fail(new Error(frame.message ?? 'Directory observation failed'));
    else if (frame.kind === 'closed') this.fail(new Error('Directory subscription ended'));
    else throw new Error('Invalid directory observer response');
    this.manager.updateReference();
  }
  async settle(): Promise<void> {
    await this.ready;
    if (this.closed) throw new Error('Directory subscription is closed');
    const request = randomUUID(), pending = deferred<void>();
    this.flushes.set(request, pending);
    this.manager.updateReference();
    this.manager.send({ op: 'flush', id: this.id, request });
    return pending.promise;
  }
  close(error = new Error('Directory subscription is closed')) {
    if (this.closed) return;
    this.closed = true;
    this.opening.reject(error);
    for (const pending of this.flushes.values()) pending.reject(error);
    this.flushes.clear();
    this.manager.remove(this);
  }
  fail(error: Error) {
    const attached = this.attached;
    this.close(error);
    // Opening failures reject readiness. An established handle loss is an error
    // event and enters the existing Documents invalidation/reconnect path.
    if (attached) this.emit('error', error);
  }
}

class WatchProcess {
  readonly subscriptions = new Map<string, DirectoryWatch>();
  private child?: ChildProcessWithoutNullStreams;
  private ended = false;
  private hello = false;
  private readonly opening = this.start();
  constructor() { void this.opening.catch(error => this.fail(asError(error))); }
  private async start() {
    const executable = await prepareKernelCommand();
    if (this.ended) return;
    const child = spawn(executable.command, [...executable.args, '--watch-directories'], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    this.child = child;
    child.stdin.on('error', error => this.fail(error));
    child.once('error', error => this.fail(error));
    child.once('exit', (code, signal) => this.fail(new Error(`Directory observer exited (${signal ?? code ?? 'unknown'})`)));
    child.stderr.on('data', chunk => { if (process.env.VARIN_KERNEL_DEBUG === '1') process.stderr.write(chunk); });
    createInterface({ input: child.stdout }).on('line', line => {
      try {
        const frame = JSON.parse(line) as Frame;
        if (frame.v !== 1) throw new Error('Directory observer protocol mismatch');
        if (!this.hello) {
          if (frame.kind !== 'hello') throw new Error('Directory observer handshake missing');
          this.hello = true; return;
        }
        if (typeof frame.id !== 'string') throw new Error('Directory observer subscription missing');
        this.subscriptions.get(frame.id)?.receive(frame);
      } catch (error) { this.fail(asError(error)); }
    });
  }
  send(command: object) {
    void this.opening.then(() => {
      if (!this.ended) this.child!.stdin.write(`${JSON.stringify(command)}\n`);
    }).catch(error => this.fail(asError(error)));
  }
  watch(path: string, changed: (event: string, filename: string | null) => void): DirectoryWatch {
    const watch = new DirectoryWatch(this, path, changed);
    this.subscriptions.set(watch.id, watch);
    this.updateReference();
    this.send({ op: 'open', id: watch.id, path });
    return watch;
  }
  remove(watch: DirectoryWatch) {
    if (!this.subscriptions.delete(watch.id)) return;
    if (this.subscriptions.size) this.send({ op: 'close', id: watch.id });
    else this.end();
    this.updateReference();
  }
  updateReference() {
    const child = this.child;
    if (!child) return;
    // A subscription has the same non-persistent lifetime as fs.watch. Keep the
    // pipes referenced only while an explicit open/flush caller awaits an ACK.
    const method = !this.ended && [...this.subscriptions.values()].some(watch => watch.pending) ? 'ref' : 'unref';
    child[method]();
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      (stream as unknown as { ref(): void; unref(): void })[method]();
    }
  }
  private end() {
    this.ended = true;
    if (shared === this) shared = undefined;
    // EOF closes every original handle. There is no orphan helper after Host exit.
    this.child?.stdin.end();
    this.updateReference();
  }
  private fail(error: Error) {
    if (this.ended) return;
    this.end();
    for (const watch of [...this.subscriptions.values()]) watch.fail(error);
  }
}
let shared: WatchProcess | undefined;
export function watchWindowsDirectory(path: string, changed: (event: string, filename: string | null) => void): NativeWatcher {
  shared ??= new WatchProcess();
  return shared.watch(path, changed);
}
