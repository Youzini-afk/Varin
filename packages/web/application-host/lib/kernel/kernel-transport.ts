import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net, { type Server, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { KERNEL_BODY_METHODS, KERNEL_CONTROL_METHODS, KERNEL_CONTROL_RESPONSE_METHODS, KERNEL_INPUT_ORDER_PARAMS, KERNEL_INLINE_MAX_BYTES, KERNEL_MAX_FRAME_BYTES, KERNEL_PROTOCOL_VERSION, KERNEL_STREAM_CREDITS } from "./protocol.generated.js";

export const CONTROL_METHODS: ReadonlySet<string> = new Set(KERNEL_CONTROL_METHODS);
export const CONTROL_RESPONSE_METHODS: ReadonlySet<string> = new Set(KERNEL_CONTROL_RESPONSE_METHODS);
const DATA_HEADER_BYTES = 25; // type + UUID + sequence
const INLINE_HEADER_BYTES = 9; // type + arrival sequence (shared with stream offers)
const BODY_METHODS: ReadonlySet<string> = new Set(KERNEL_BODY_METHODS);
type CreditGroup = 'request' | 'control' | 'reverse';
interface InlineFrame { bytes: Buffer; resolve(): void; reject(error: Error): void }

// Only contracts that can contain unbounded bodies need this bounded sizing pass. Count a
// lower bound on JSON bytes, stopping at the inline budget, rather than cloning a huge value
// into the event loop's JSON encoder. Small typed requests still avoid the worker entirely.
function needsBodyWorker(value: unknown): boolean {
  let size = 0;
  function* fields(item: object): Generator<unknown> {
    if (Array.isArray(item)) { yield* item; }
    else { for (const key in item) { if (Object.hasOwn(item, key)) { size += key.length + 3; yield (item as Envelope)[key]; } } }
  }
  const stack: Iterator<unknown>[] = [[value][Symbol.iterator]()];
  while (stack.length && size <= KERNEL_INLINE_MAX_BYTES) {
    const next = stack[stack.length - 1]!.next();
    if (next.done) { stack.pop(); continue; }
    const item = next.value;
    if (typeof item === 'string') size += item.length + 2;
    else if (item && typeof item === 'object') { size += 2; stack.push(fields(item)); }
    else size += 1;
  }
  return size > KERNEL_INLINE_MAX_BYTES;
}

type Envelope = Record<string, unknown>;
interface Outgoing {
  id: string; bytes?: Buffer; offset: number; sequence: number; ready: boolean; waiting: boolean;
  requestId?: string; aborting: boolean; ending: boolean; group: CreditGroup; started: boolean; opened: boolean; encoding: boolean; settled: boolean; value?: Envelope;
  resolve(): void; reject(error: Error): void;
}
interface Incoming { identity: Envelope; length?: number; received: number; sequence: number; stopping: boolean; abortSequence?: number }
const identity = (value: Envelope): Envelope => {
  const result: Envelope = Object.fromEntries(["v", "kind", "id", "method", "epoch", "grantId", "kernelEpoch"].filter(key => value[key] !== undefined).map(key => [key, value[key]]));
  const field = KERNEL_INPUT_ORDER_PARAMS[value.method as keyof typeof KERNEL_INPUT_ORDER_PARAMS];
  const target = field && value.params && typeof value.params === 'object' ? (value.params as Envelope)[field] : undefined;
  if (value.kind === 'request' && typeof target === 'string') result.inputOrderKey = `input:${field}:${target}`;
  return result;
};
export function controlFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length > KERNEL_MAX_FRAME_BYTES) throw new Error("Kernel control frame exceeds the protocol frame bound");
  const header = Buffer.allocUnsafe(4); header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

// Large-body encoding, assembly and hydration stay off the Host event loop. Inline messages
// never enter this worker. It is started lazily, only when a large body actually occurs.
// Use an embedded program so bundled and source Host builds share the exact same worker.
const BODY_WORKER = String.raw`
import { parentPort } from "node:worker_threads";
const streams = new Map();
const inputOrderParams = ${JSON.stringify(KERNEL_INPUT_ORDER_PARAMS)};
const identity = value => {
  const result = Object.fromEntries(["v","kind","id","method","epoch","grantId","kernelEpoch"].filter(key => value[key] !== undefined).map(key => [key,value[key]]));
  const field = inputOrderParams[value.method];
  const target = field && value.params && typeof value.params === 'object' ? value.params[field] : undefined;
  if (value.kind === 'request' && typeof target === 'string') result.inputOrderKey = 'input:' + field + ':' + target;
  return result;
};
parentPort.on("message", message => {
  const { type, id } = message;
  try {
    if (type === "encode") {
      const bytes = new TextEncoder().encode(JSON.stringify(message.value));
      parentPort.postMessage({ type:"encoded", id, bytes:bytes.buffer }, [bytes.buffer]);
    } else if (type === "open") streams.set(id, { identity:message.identity, chunks:[], length:0 });
    else if (type === "chunk") {
      const stream = streams.get(id);
      if (!stream) throw new Error("Unknown body stream");
      stream.chunks.push(new Uint8Array(message.bytes)); stream.length += message.bytes.byteLength;
      parentPort.postMessage({ type:"ack", id, sequence:message.sequence });
    } else if (type === "end") {
      const stream = streams.get(id); streams.delete(id);
      if (!stream) throw new Error("Unknown completed body stream");
      const bytes = Buffer.concat(stream.chunks, stream.length);
      const value = JSON.parse(bytes.toString("utf8"));
      const actual = identity(value);
      if (Object.keys(actual).length !== Object.keys(stream.identity).length
        || Object.entries(actual).some(([key, value]) => stream.identity[key] !== value)) throw new Error("Body identity mismatch");
      parentPort.postMessage({ type:"decoded", id, value });
    } else if (type === "abort") streams.delete(id);
  } catch (error) { parentPort.postMessage({ type:"failed", id, operation:type, message:error instanceof Error ? error.message : String(error) }); }
});
`;

/** One authenticated process epoch owns both connections. Losing either invalidates all handles. */
export class KernelTransport {
  private readonly token = randomBytes(32).toString("hex");
  private bodyWorker?: Worker;
  private get worker(): Worker {
    if (!this.bodyWorker) {
      const worker = this.bodyWorker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(BODY_WORKER)}`), {execArgv: []});
      worker.on("error", error => this.fail(error));
      worker.on("exit", code => { if (!this.intentionalClose) this.fail(new Error(`Kernel body worker exited (${code})`)); });
      worker.on("message", message => this.fromWorker(message as Envelope));
    }
    return this.bodyWorker;
  }
  private readonly inline: InlineFrame[] = [];
  private inlineTurn = true;
  private arrivalSequence = 0;
  private readonly requestArrivals = new Map<string, number>();
  private readonly streamsUsed: Record<CreditGroup, number> = {request: 0, control: 0, reverse: 0};
  private readonly sockets = new Set<Socket>();
  private readonly outgoing = new Map<string, Outgoing>();
  private readonly incoming = new Map<string, Incoming>();
  private readonly decoding = new Map<string, Incoming>();
  private readonly cancelledResponses = new Set<string>();
  private order: string[] = [];
  private control?: Socket;
  private data?: Socket;
  private controlBuffer = Buffer.alloc(0);
  private dataBuffer = Buffer.alloc(0);
  private pumping = false;
  private epoch?: string;
  private failed?: Error;
  private intentionalClose = false;
  private resolveBound!: () => void;
  private rejectBound!: (error: Error) => void;
  readonly bound = new Promise<void>((resolve, reject) => { this.resolveBound = resolve; this.rejectBound = reject; });
  private constructor(
    private readonly endpoints: { control: string; data: string },
    private readonly servers: Server[],
    private readonly directory: string | undefined,
    private readonly onFrame: (frame: unknown) => void,
    private readonly onFailure: (error: Error) => void,
    private readonly onResponseDiscarded: (requestId: string) => void,
  ) {
    void this.bound.catch(() => undefined);
    servers[0]!.on("connection", socket => this.accept(socket, "control"));
    servers[1]!.on("connection", socket => this.accept(socket, "data"));
  }
  static async prepare(onFrame: (frame: unknown) => void, onFailure: (error: Error) => void, onResponseDiscarded: (requestId: string) => void): Promise<KernelTransport> {
    const directory = process.platform === "win32" ? undefined : await fs.mkdtemp(path.join(os.tmpdir(), "varin-kernel-"));
    if (directory) await fs.chmod(directory, 0o700);
    const nonce = randomUUID();
    const endpoints = directory
      ? { control:path.join(directory, "control.sock"), data:path.join(directory, "data.sock") }
      : { control:`\\\\.\\pipe\\varin-kernel-${nonce}-control`, data:`\\\\.\\pipe\\varin-kernel-${nonce}-data` };
    const servers = [net.createServer(), net.createServer()];
    const transport = new KernelTransport(endpoints, servers, directory, onFrame, onFailure, onResponseDiscarded);
    try {
      await Promise.all(servers.map((server, index) => new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(index === 0 ? endpoints.control : endpoints.data, () => { server.removeListener("error", reject); resolve(); });
      })));
      for (const server of servers) server.on("error", error => transport.fail(error));
      return transport;
    } catch (error) { await transport.close(); throw error; }
  }
  bootstrap(): Envelope {
    // Socket highWaterMark is the actual selected local I/O buffer, rather than a body limit.
    // The wire can represent larger frames; rotating at this granularity keeps streams fair.
    const probe = new net.Socket();
    const chunkBytes = Math.min(probe.writableHighWaterMark, KERNEL_MAX_FRAME_BYTES - DATA_HEADER_BYTES);
    probe.destroy();
    return { v:KERNEL_PROTOCOL_VERSION, kind:"transport-bootstrap", controlEndpoint:this.endpoints.control,
      dataEndpoint:this.endpoints.data, token:this.token, chunkBytes };
  }
  get kernelEpoch(): string | undefined { return this.epoch; }
  private accept(socket: Socket, lane: "control" | "data"): void {
    this.sockets.add(socket);
    let auth = Buffer.alloc(0);
    let authenticated = false;
    const consume = (chunk: Buffer) => {
      if (authenticated) { this.consume(lane, chunk); return; }
      auth = Buffer.concat([auth, chunk]);
      if (auth.length < 4) return;
      const length = auth.readUInt32BE(0);
      if (length > KERNEL_MAX_FRAME_BYTES) { socket.destroy(); return; }
      if (auth.length < 4 + length) return;
      let value: Envelope;
      try { value = JSON.parse(auth.subarray(4, 4 + length).toString("utf8")) as Envelope; }
      catch { socket.destroy(); return; }
      if (value.v !== KERNEL_PROTOCOL_VERSION || value.kind !== "transport-auth" || value.lane !== lane
        || value.token !== this.token || typeof value.kernelEpoch !== "string" || !value.kernelEpoch
        || (this.epoch !== undefined && this.epoch !== value.kernelEpoch) || this[lane]) { socket.destroy(); return; }
      authenticated = true;
      this.epoch = value.kernelEpoch;
      this[lane] = socket;
      const remaining = auth.subarray(4 + length); auth = Buffer.alloc(0);
      void this.write(socket, controlFrame({ v:KERNEL_PROTOCOL_VERSION, kind:"transport-bound", lane, kernelEpoch:this.epoch })).catch(error => this.fail(error as Error));
      if (remaining.length) this.consume(lane, remaining);
      if (this.control && this.data) {
        for (const server of this.servers) server.close();
        for (const pending of this.sockets) if (pending !== this.control && pending !== this.data) pending.destroy();
        this.resolveBound();
      }
    };
    socket.on("data", consume);
    socket.on("error", error => { if (authenticated) this.fail(error); });
    socket.on("close", () => {
      this.sockets.delete(socket);
      if (authenticated && !this.intentionalClose) this.fail(new Error(`Kernel ${lane} connection disconnected`));
    });
  }
  private write(socket: Socket | undefined, bytes: Buffer): Promise<void> {
    if (this.failed || this.intentionalClose) return Promise.reject(this.failed ?? new Error("Kernel transport closed"));
    if (!socket || socket.destroyed) return Promise.reject(new Error("Kernel local connection is unavailable"));
    return new Promise((resolve, reject) => socket.write(bytes, error => error ? reject(error) : resolve()));
  }
  private command(kind: string, id: string, fields: Envelope = {}): Promise<void> {
    return this.write(this.control, controlFrame({ v:KERNEL_PROTOCOL_VERSION, kind, streamId:id, kernelEpoch:this.epoch, ...fields }));
  }
  send(value: Envelope, lane: "control" | "data"): Promise<void> {
    if (lane === "control") {
      // Control can overtake a queued inline frame on the other socket. The receiver holds
      // this cancel until that exact arrival is registered, without a wire acknowledgement.
      const arrivalSequence = value.kind === 'cancel' && typeof value.id === 'string' ? this.requestArrivals.get(value.id) : undefined;
      return this.write(this.control, controlFrame(arrivalSequence === undefined ? value : {...value, arrivalSequence}));
    }
    if (this.failed || this.intentionalClose) return Promise.reject(this.failed ?? new Error("Kernel transport closed"));
    const inWorker = (value.kind !== 'request' || BODY_METHODS.has(String(value.method))) && needsBodyWorker(value);
    let bytes: Buffer | undefined;
    try { if (!inWorker) bytes = Buffer.from(JSON.stringify(value), 'utf8'); }
    catch (error) { return Promise.reject(error); }
    const arrivalSequence = ++this.arrivalSequence;
    if (value.kind === 'request' && typeof value.id === 'string') this.requestArrivals.set(value.id, arrivalSequence);
    if (bytes && bytes.length <= KERNEL_INLINE_MAX_BYTES) {
      const header = Buffer.allocUnsafe(4 + INLINE_HEADER_BYTES);
      header.writeUInt32BE(INLINE_HEADER_BYTES + bytes.length, 0);
      header[4] = 1;
      header.writeBigUInt64BE(BigInt(arrivalSequence), 5);
      return new Promise<void>((resolve, reject) => {
        this.inline.push({bytes: Buffer.concat([header, bytes!]), resolve, reject});
        void this.pump();
      });
    }
    const id = randomUUID();
    return new Promise<void>((resolve, reject) => {
      const group: CreditGroup = value.kind !== 'request' ? 'reverse' : CONTROL_RESPONSE_METHODS.has(String(value.method)) ? 'control' : 'request';
      this.outgoing.set(id, { id, offset:0, sequence:0, ready:false, waiting:false, aborting:false, ending:false,
        group, started:false, opened:false, encoding:false, settled:false, ...(bytes ? {bytes} : {value}),
        ...(value.kind === 'request' && typeof value.id === 'string' ? {requestId:value.id} : {}), resolve, reject });
      this.order.push(id);
      // Offers reserve arrival order before any encoding or stream-credit wait. They carry
      // identity only; body memory/worker/socket credit is acquired separately below.
      void this.command('transport-stream-open', id, { identity:identity(value), arrivalSequence }).then(() => {
        const stream = this.outgoing.get(id);
        if (!stream || stream.aborting) return;
        stream.opened = true;
        this.startStreams();
      }, error => this.fail(error as Error));
    });
  }
  private startStreams(): void {
    for (const stream of this.outgoing.values()) {
      if (!stream.opened || stream.started || stream.aborting || this.streamsUsed[stream.group] >= KERNEL_STREAM_CREDITS) continue;
      stream.started = true;
      this.streamsUsed[stream.group]++;
      if (stream.bytes) void this.command('transport-stream-begin', stream.id, {byteLength:stream.bytes.length}).catch(error => this.fail(error as Error));
      else {
        try { stream.encoding = true; this.worker.postMessage({type:'encode', id:stream.id, value:stream.value}); delete stream.value; }
        catch (error) { stream.encoding = false; this.abortOutgoing(stream.id, error instanceof Error ? error : new Error(String(error))); }
      }
    }
  }
  private settleStream(id: string): Outgoing | undefined {
    const stream = this.outgoing.get(id);
    if (!stream) return;
    if (stream.encoding) { stream.settled = true; return stream; }
    this.outgoing.delete(id);
    if (stream.started) this.streamsUsed[stream.group]--;
    this.startStreams();
    return stream;
  }
  private deliver(value: Envelope): void {
    if (value.kind === 'response' && typeof value.id === 'string') {
      this.requestArrivals.delete(value.id);
      if (this.cancelledResponses.delete(value.id)) { this.onResponseDiscarded(value.id); return; }
    }
    this.onFrame(value);
  }
  private abortOutgoing(id: string, error: Error): void {
    const stream = this.outgoing.get(id); if (!stream) return;
    if (stream.aborting || stream.ending) return;
    stream.aborting = true;
    delete stream.bytes;
    delete stream.value;
    this.order = this.order.filter(item => item !== id);
    void this.command("transport-stream-abort", id, {sequence:stream.sequence}).catch(failure => this.fail(failure as Error));
    stream.reject(error);
  }
  cancelRequest(requestId: string, discardResponse: boolean): void {
    for (const stream of this.outgoing.values()) {
      if (stream.requestId === requestId) this.abortOutgoing(stream.id, new DOMException("Body transfer cancelled", "AbortError"));
    }
    if (!discardResponse) return;
    this.cancelledResponses.add(requestId);
    for (const [id, stream] of this.incoming) {
      if (stream.identity.kind === 'response' && stream.identity.id === requestId) this.stopIncoming(id, stream);
    }
  }
  private stopIncoming(id: string, stream: Incoming): void {
    if (stream.stopping) return;
    stream.stopping = true;
    this.worker.postMessage({type:'abort', id});
    void this.command('transport-stream-stop', id).catch(error => this.fail(error as Error));
  }
  private discardResponse(stream: Incoming): void {
    if (stream.identity.kind !== 'response' || typeof stream.identity.id !== 'string') return;
    this.cancelledResponses.delete(stream.identity.id);
    this.requestArrivals.delete(stream.identity.id);
    this.onResponseDiscarded(stream.identity.id);
  }
  private finishAbort(id: string, stream: Incoming): void {
    this.incoming.delete(id);
    void this.command('transport-stream-aborted', id, {sequence:stream.sequence}).catch(error => this.fail(error as Error));
    this.discardResponse(stream);
  }
  private fromWorker(message: Envelope): void {
    if (this.failed || this.intentionalClose) return;
    const id = String(message.id);
    if (message.type === "encoded") {
      const stream = this.outgoing.get(id); if (!stream) return;
      stream.encoding = false;
      if (stream.aborting) { if (stream.settled) this.settleStream(id); return; }
      stream.bytes = Buffer.from(message.bytes as ArrayBuffer);
      void this.command("transport-stream-begin", id, { byteLength:stream.bytes.length }).catch(error => this.fail(error as Error));
    } else if (message.type === "ack") {
      const stream = this.incoming.get(id);
      if (stream && !stream.stopping && stream.abortSequence === undefined) void this.command("transport-stream-ack", id, { sequence:message.sequence }).catch(error => this.fail(error as Error));
    } else if (message.type === "decoded") {
      const value = message.value as Envelope;
      const stream = this.decoding.get(id);
      this.decoding.delete(id);
      this.deliver(value);
      if (stream) void this.command('transport-stream-ended', id, {sequence:stream.sequence}).catch(error => this.fail(error as Error));
    } else if (message.type === "failed") {
      const error = new Error(`Kernel body ${String(message.operation)} failed: ${String(message.message)}`);
      if (message.operation === "encode") {
        const stream = this.outgoing.get(id);
        if (stream) { stream.encoding = false; if (stream.settled) this.settleStream(id); else this.abortOutgoing(id, error); }
      } else this.fail(error);
    }
  }
  private consume(lane: "control" | "data", chunk: Buffer): void {
    try {
      let buffer = Buffer.concat([lane === "control" ? this.controlBuffer : this.dataBuffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0);
        if (length > KERNEL_MAX_FRAME_BYTES) throw new Error("Kernel frame exceeds protocol bound");
        if (buffer.length < 4 + length) break;
        const body = buffer.subarray(4, 4 + length); buffer = buffer.subarray(4 + length);
        if (lane === "control") this.consumeControl(JSON.parse(body.toString("utf8")) as Envelope);
        else this.consumeData(body);
      }
      if (lane === "control") this.controlBuffer = buffer; else this.dataBuffer = buffer;
    } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
  }
  private consumeControl(value: Envelope): void {
    if (typeof value.kind !== "string" || !value.kind.startsWith("transport-stream-")) {
      this.deliver(value); return;
    }
    if (value.v !== KERNEL_PROTOCOL_VERSION || value.kernelEpoch !== this.epoch || typeof value.streamId !== "string") throw new Error("Kernel stream epoch or identity mismatch");
    const id = value.streamId;
    const stream = this.outgoing.get(id);
    switch (value.kind) {
      case "transport-stream-open": {
        if (this.incoming.has(id) || !value.identity || typeof value.identity !== "object") throw new Error("Invalid incoming stream identity");
        const received: Incoming = { identity:value.identity as Envelope, received:0, sequence:0, stopping:false };
        this.incoming.set(id, received);
        this.worker.postMessage({ type:"open", id, identity:value.identity });
        if (received.identity.kind === 'response' && typeof received.identity.id === 'string' && this.cancelledResponses.has(received.identity.id)) this.stopIncoming(id, received);
        break;
      }
      case "transport-stream-begin": {
        const received = this.incoming.get(id);
        if (!received || received.length !== undefined || !Number.isSafeInteger(value.byteLength) || Number(value.byteLength) < 0) throw new Error("Invalid incoming stream length");
        received.length = Number(value.byteLength);
        if (!received.stopping) void this.command("transport-stream-ready", id).catch(error => this.fail(error as Error)); break;
      }
      case "transport-stream-ready":
        if (stream?.aborting) break;
        if (!stream?.bytes || stream.ready) throw new Error("Invalid body credit");
        stream.ready = true; void this.pump(); break;
      case "transport-stream-ack":
        if (stream?.aborting && value.sequence === stream.sequence) break;
        if (!stream?.waiting || value.sequence !== stream.sequence) throw new Error("Invalid body acknowledgement");
        stream.waiting = false; void this.pump(); break;
      case "transport-stream-end": {
        const received = this.incoming.get(id);
        if (!received || received.length !== received.received || value.sequence !== received.sequence) throw new Error("Incomplete body stream");
        this.incoming.delete(id);
        if (received.stopping) {
          void this.command('transport-stream-ended', id, {sequence:received.sequence}).catch(error => this.fail(error as Error));
          this.discardResponse(received);
        } else {
          this.decoding.set(id, received);
          this.worker.postMessage({ type:"end", id });
        }
        break;
      }
      case "transport-stream-abort": {
        const received = this.incoming.get(id);
        if (!received || received.abortSequence !== undefined || !Number.isSafeInteger(value.sequence) || Number(value.sequence) < received.sequence) throw new Error("Invalid aborted stream");
        received.stopping = true; received.abortSequence = Number(value.sequence);
        this.worker.postMessage({ type:"abort", id });
        if (received.sequence === received.abortSequence) this.finishAbort(id, received);
        break;
      }
      case 'transport-stream-stop':
        if (!stream) throw new Error('Unknown stopped stream');
        this.abortOutgoing(id, new DOMException('Body receiver stopped', 'AbortError')); break;
      case "transport-stream-aborted":
        if (!stream?.aborting || value.sequence !== stream.sequence) throw new Error("Invalid aborted stream receipt");
        this.settleStream(id); break;
      case 'transport-stream-ended':
        if (!stream?.ending || value.sequence !== stream.sequence) throw new Error('Invalid completed stream receipt');
        this.settleStream(id); stream.resolve(); break;
      default: throw new Error("Unknown kernel transport command");
    }
  }
  private consumeData(body: Buffer): void {
    if (body[0] === 1) {
      if (body.length < INLINE_HEADER_BYTES || body.length - INLINE_HEADER_BYTES > KERNEL_INLINE_MAX_BYTES) throw new Error('Invalid inline frame length');
      this.deliver(JSON.parse(body.subarray(INLINE_HEADER_BYTES).toString('utf8')) as Envelope);
      return;
    }
    if (body[0] !== 0) throw new Error('Unknown kernel data frame type');
    if (body.length < DATA_HEADER_BYTES) throw new Error("Truncated kernel data frame");
    const hex = body.subarray(1, 17).toString("hex");
    const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    const sequence = Number(body.readBigUInt64BE(17));
    const stream = this.incoming.get(id);
    const payload = body.subarray(DATA_HEADER_BYTES);
    if (!stream || stream.length === undefined || !payload.length || !Number.isSafeInteger(sequence)
      || sequence !== stream.sequence + 1 || payload.length > stream.length - stream.received) throw new Error("Invalid kernel data sequence or length");
    stream.sequence = sequence; stream.received += payload.length;
    if (stream.abortSequence !== undefined) {
      if (sequence > stream.abortSequence) throw new Error('Data exceeds aborted sequence');
      if (sequence === stream.abortSequence) this.finishAbort(id, stream);
      return;
    }
    if (stream.stopping) {
      void this.command('transport-stream-ack', id, {sequence}).catch(error => this.fail(error as Error)); return;
    }
    const bytes = Uint8Array.from(payload);
    this.worker.postMessage({ type:"chunk", id, sequence, bytes:bytes.buffer }, [bytes.buffer]);
  }
  private async pump(): Promise<void> {
    if (this.pumping || this.failed) return;
    this.pumping = true;
    try {
      while (!this.failed) {
        let selected: Outgoing | undefined;
        for (let count = this.order.length; count > 0; count--) {
          const id = this.order.shift()!; this.order.push(id);
          const stream = this.outgoing.get(id);
          if (stream?.bytes && !stream.aborting && !stream.ending && stream.ready && !stream.waiting) { selected = stream; break; }
        }
        if (this.inline.length && (this.inlineTurn || !selected)) {
          const frame = this.inline.shift()!;
          try { await this.write(this.data, frame.bytes); frame.resolve(); }
          catch (error) { frame.reject(error as Error); throw error; }
          this.inlineTurn = false;
          continue;
        }
        if (!selected?.bytes) break;
        this.inlineTurn = true;
        const stream = selected;
        if (stream.offset === stream.bytes!.length) {
          stream.ending = true; delete stream.bytes; this.order = this.order.filter(id => id !== stream.id);
          await this.command("transport-stream-end", stream.id, { sequence:stream.sequence }); continue;
        }
        const chunkBytes = Math.min(this.data!.writableHighWaterMark, KERNEL_MAX_FRAME_BYTES - DATA_HEADER_BYTES);
        const end = Math.min(stream.offset + chunkBytes, stream.bytes!.length);
        const header = Buffer.allocUnsafe(4 + DATA_HEADER_BYTES);
        header.writeUInt32BE(DATA_HEADER_BYTES + end - stream.offset, 0);
        header[4] = 0;
        Buffer.from(stream.id.replaceAll("-", ""), "hex").copy(header, 5);
        header.writeBigUInt64BE(BigInt(++stream.sequence), 21);
        const frame = Buffer.concat([header, stream.bytes!.subarray(stream.offset, end)]);
        stream.offset = end; stream.waiting = true;
        await this.write(this.data, frame);
      }
    } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
    finally { this.pumping = false; }
  }
  fail(error: Error): void {
    if (this.failed || this.intentionalClose) return;
    this.failed = error; this.rejectBound(error);
    for (const stream of this.outgoing.values()) stream.reject(error);
    for (const frame of this.inline.splice(0)) frame.reject(error);
    this.outgoing.clear(); this.incoming.clear(); this.decoding.clear(); this.cancelledResponses.clear(); this.requestArrivals.clear(); this.order = [];
    for (const socket of this.sockets) socket.destroy();
    this.onFailure(error);
    void this.close();
  }
  async close(): Promise<void> {
    if (this.intentionalClose) return;
    this.intentionalClose = true;
    const error = this.failed ?? new Error("Kernel transport closed");
    this.rejectBound(error);
    for (const stream of this.outgoing.values()) stream.reject(error);
    for (const frame of this.inline.splice(0)) frame.reject(error);
    this.outgoing.clear(); this.incoming.clear(); this.decoding.clear(); this.cancelledResponses.clear(); this.requestArrivals.clear(); this.order = [];
    for (const socket of this.sockets) socket.destroy();
    await Promise.all(this.servers.map(server => new Promise<void>(resolve => { server.close(() => resolve()); })));
    await this.bodyWorker?.terminate();
    if (this.directory) await fs.rmdir(this.directory).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
  }
}
