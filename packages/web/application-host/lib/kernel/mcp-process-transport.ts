import {
  McpConnectionClosedError, McpMessageTooLargeError, parseJsonRpcMessage,
  type JsonRpcMessage, type McpTransport, type StdioTransportOptions,
} from '../mcp/authority.js';
import {
  launchOwnedProcess, ManagedProcessLaunchError, terminateManagedProcess,
  type ManagedPipedProcessHandle, type ManagedProcessOwner,
} from '../process/types.js';

// The SDK's public options allow overrides; its default stdio frame budget is 16 MiB.
const DEFAULT_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;
const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;
const STDIN_CLOSE_GRACE_MS = 500;
type MessageListener = Parameters<McpTransport['onMessage']>[0];
type ErrorListener = Parameters<McpTransport['onError']>[0];
type CloseListener = Parameters<McpTransport['onClose']>[0];
export type McpProcessSpawn = (
  options: Readonly<StdioTransportOptions>, signal: AbortSignal,
) => ManagedPipedProcessHandle | Promise<ManagedPipedProcessHandle>;

/** The caller supplies the original admitted owner, not a second process registry. */
export function createMcpProcessTransport(
  options: Readonly<StdioTransportOptions>, spawn: McpProcessSpawn,
  owner: ManagedProcessOwner<ManagedPipedProcessHandle>,
): McpTransport & { readonly stderr: string } {
  return new McpProcessTransport(options, spawn, owner);
}

function requireNativeCompletion(child: ManagedPipedProcessHandle): Promise<void> {
  if (!child.completion || !child.requestTermination) {
    throw new Error('MCP stdio requires an owned native process completion and termination port');
  }
  return child.completion;
}

/** A timeout means escalation is due. Only the original completion can prove exit. */
async function completedWithin(completion: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      completion.then(() => true),
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

/** JSON-RPC framing only. Rust retains process-tree, directory-writer and stdin authority. */
class McpProcessTransport implements McpTransport {
  private readonly messages = new Set<MessageListener>();
  private readonly errors = new Set<ErrorListener>();
  private readonly closes = new Set<CloseListener>();
  private readonly reportedErrors = new WeakSet<Error>();
  private started = false;
  private closed = false;
  private closeEmitted = false;
  private closePromise?: Promise<void>;
  private observedChild: ManagedPipedProcessHandle | null = null;
  private detach?: () => void;
  private frameParts: Buffer[] = [];
  private frameBytes = 0;
  private stderrBuffer: Buffer = Buffer.alloc(0);

  constructor(
    private readonly options: Readonly<StdioTransportOptions>,
    private readonly spawn: McpProcessSpawn,
    private readonly owner: ManagedProcessOwner<ManagedPipedProcessHandle>,
  ) {}

  get stderr(): string { return this.stderrBuffer.toString('utf8'); }
  onMessage(listener: MessageListener): () => void { this.messages.add(listener); return () => { this.messages.delete(listener); }; }
  onError(listener: ErrorListener): () => void { this.errors.add(listener); return () => { this.errors.delete(listener); }; }
  onClose(listener: CloseListener): () => void { this.closes.add(listener); return () => { this.closes.delete(listener); }; }

  async start(): Promise<void> {
    if (this.closed) throw new McpConnectionClosedError();
    if (this.started) throw new Error('MCP stdio transport already started');
    if (this.owner.child || this.owner.pendingSpawn) throw new Error('MCP stdio process owner is already in use');
    this.started = true;
    try {
      const child = await launchOwnedProcess(this.owner, async signal => {
        const launched = await this.spawn(this.options, signal);
        try { requireNativeCompletion(launched); }
        catch (error) { throw new ManagedProcessLaunchError(launched, error); }
        return launched;
      });
      this.observe(child);
      if (this.closed) throw new McpConnectionClosedError();
    } catch (error) {
      // A failed native handoff can leave a live child. Keep the same owner for close/drain.
      if (this.owner.child) this.observe(this.owner.child);
      throw error;
    }
  }

  async send(message: JsonRpcMessage): Promise<void> {
    const stdin = this.owner.child?.stdin;
    if (!this.started || this.closed || !stdin?.writable) throw new McpConnectionClosedError();
    const payload = `${JSON.stringify(message)}\n`;
    // The Writable callback is the original kernel input receipt, not local buffer acceptance.
    await new Promise<void>((resolve, reject) => {
      stdin.write(payload, error => { if (error) reject(error); else resolve(); });
    });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.clearFrame();
    (this.owner.launchController ??= new AbortController()).abort();
    // Keep the rejected promise: a repeated close cannot turn unknown exit into success.
    this.closePromise = this.drainOwner();
    void this.closePromise.catch(() => undefined);
    return this.closePromise;
  }

  private async drainOwner(): Promise<void> {
    // launchOwnedProcess also drains a child that arrives after cancellation. A failed
    // late drain leaves owner.child attached, so this path still observes/retains it.
    await this.owner.pendingSpawn?.catch(() => undefined);
    const child = this.owner.child;
    if (child) {
      const completion = requireNativeCompletion(child);
      this.observe(child);
      child.stdout.resume(); child.stderr.resume();
      child.stdin.end();
      const timeoutMs = this.options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
      if (!await completedWithin(completion, Math.min(STDIN_CLOSE_GRACE_MS, timeoutMs))) {
        await child.requestTermination!(false);
        if (!await completedWithin(completion, timeoutMs)) await terminateManagedProcess(child, true);
      }
      if (this.owner.child === child) this.owner.child = null;
    }
    this.detach?.();
    this.emitClose();
  }

  private observe(child: ManagedPipedProcessHandle): void {
    if (this.observedChild === child) return;
    this.observedChild = child;
    const stdout = (chunk: Buffer | string) => this.handleStdout(chunk);
    const stderr = (chunk: Buffer | string) => this.handleStderr(chunk);
    const failure = (error: Error) => { if (!this.closed) this.fail(error); };
    const end = () => {
      if (!this.closed && this.frameBytes && Buffer.concat(this.frameParts, this.frameBytes).toString('utf8').trim()) {
        this.report(new Error('MCP stdio server closed with an incomplete JSON-RPC message'));
      }
      void this.close().catch(error => this.report(error));
    };
    child.on('error', failure);
    child.stdin.on('error', failure);
    child.stdout.on('error', failure);
    child.stderr.on('error', failure);
    child.stdout.on('data', stdout);
    child.stderr.on('data', stderr);
    child.stdout.once('end', end);
    this.detach = () => {
      child.off('error', failure);
      child.stdin.off('error', failure);
      child.stdout.off('error', failure);
      child.stderr.off('error', failure);
      child.stdout.off('data', stdout);
      child.stderr.off('data', stderr);
      child.stdout.off('end', end);
    };
    // A root's exit/close event and a successful termination request are not tree receipts.
    // Keep ordinary output draining until stdout ends, even if completion was already ready
    // when the admitted handle arrived with buffered output.
    void child.completion?.catch(error => this.fail(error));
    if (child.stdout.readableEnded) end();
  }

  private clearFrame(): void { this.frameParts = []; this.frameBytes = 0; }

  private handleStdout(chunk: Buffer | string): void {
    if (this.closed) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const limit = this.options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
    let offset = 0;
    while (offset < buffer.length && !this.closed) {
      const newline = buffer.indexOf(0x0a, offset);
      const end = newline < 0 ? buffer.length : newline;
      const bytes = end - offset;
      if (this.frameBytes + bytes > limit) {
        this.fail(new McpMessageTooLargeError(limit));
        return;
      }
      if (bytes) { this.frameParts.push(buffer.subarray(offset, end)); this.frameBytes += bytes; }
      if (newline < 0) return;
      // Decode only complete raw byte frames, preserving split UTF-8 and CRLF boundaries.
      const text = Buffer.concat(this.frameParts, this.frameBytes).toString('utf8').replace(/\r$/, '');
      this.clearFrame();
      offset = newline + 1;
      if (!text.trim()) continue;
      try {
        const message = parseJsonRpcMessage(JSON.parse(text));
        for (const listener of this.messages) listener(message);
      } catch (error) { this.report(error); }
    }
  }

  private handleStderr(chunk: Buffer | string): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const limit = Math.max(0, this.options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES);
    if (!limit) this.stderrBuffer = Buffer.alloc(0);
    else if (buffer.length >= limit) this.stderrBuffer = Buffer.from(buffer.subarray(buffer.length - limit));
    else this.stderrBuffer = Buffer.concat([this.stderrBuffer.subarray(Math.max(0, this.stderrBuffer.length + buffer.length - limit)), buffer]);
    if (this.options.stderr === 'inherit') process.stderr.write(buffer);
    try { this.options.onStderr?.(buffer.toString('utf8')); }
    catch (error) { this.report(error); }
  }

  private fail(value: unknown): void {
    this.closed = true;
    this.clearFrame();
    this.report(value);
    // Broken protocol settles SDK requests immediately; close() separately proves tree exit.
    this.emitClose();
    void this.close().catch(error => this.report(error));
  }

  private report(value: unknown): void {
    const error = value instanceof Error ? value : new Error(String(value));
    if (this.reportedErrors.has(error)) return;
    this.reportedErrors.add(error);
    for (const listener of this.errors) listener(error);
  }

  private emitClose(): void {
    if (this.closeEmitted) return;
    this.closeEmitted = true;
    for (const listener of this.closes) listener();
  }
}
