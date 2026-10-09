import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net, { type Server, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { KERNEL_CONTROL_METHODS, KERNEL_MAX_FRAME_BYTES, KERNEL_PROTOCOL_VERSION } from "./protocol.generated.js";

export const CONTROL_METHODS: ReadonlySet<string> = new Set(KERNEL_CONTROL_METHODS);
const DATA_HEADER_BYTES = 24;
type Envelope = Record<string, unknown>;
interface Outgoing {
  id: string; bytes?: Buffer; offset: number; sequence: number; ready: boolean; waiting: boolean;
  requestId?: string; aborting: boolean;
  resolve(): void; reject(error: Error): void;
}
interface Incoming { identity: Envelope; length?: number; received: number; sequence: number }
const identity = (value: Envelope): Envelope => Object.fromEntries(
  ["v", "kind", "id", "method", "epoch", "grantId", "kernelEpoch"].filter(key => value[key] !== undefined).map(key => [key, value[key]]),
);
export function controlFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length > KERNEL_MAX_FRAME_BYTES) throw new Error("Kernel control frame exceeds the protocol frame bound");
  const header = Buffer.allocUnsafe(4); header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

// This worker owns JSON body encoding, content assembly, and hydration. The main Host only
// handles bounded control envelopes and one socket-buffer-sized binary chunk at a time.
// Use an embedded program so bundled and source Host builds share the exact same worker.
const BODY_WORKER = String.raw`
import { parentPort } from "node:worker_threads";
const streams = new Map();
const identity = value => Object.fromEntries(["v","kind","id","method","epoch","grantId","kernelEpoch"].filter(key => value[key] !== undefined).map(key => [key,value[key]]));
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
  private readonly worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(BODY_WORKER)}`), {execArgv: []});
  private readonly sockets = new Set<Socket>();
  private readonly outgoing = new Map<string, Outgoing>();
  private readonly incoming = new Map<string, Incoming>();
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
  ) {
    void this.bound.catch(() => undefined);
    this.worker.on("error", error => this.fail(error));
    this.worker.on("exit", code => { if (!this.intentionalClose) this.fail(new Error(`Kernel body worker exited (${code})`)); });
    this.worker.on("message", message => this.fromWorker(message as Envelope));
    servers[0]!.on("connection", socket => this.accept(socket, "control"));
    servers[1]!.on("connection", socket => this.accept(socket, "data"));
  }
  static async prepare(onFrame: (frame: unknown) => void, onFailure: (error: Error) => void): Promise<KernelTransport> {
    const directory = process.platform === "win32" ? undefined : await fs.mkdtemp(path.join(os.tmpdir(), "varin-kernel-"));
    if (directory) await fs.chmod(directory, 0o700);
    const nonce = randomUUID();
    const endpoints = directory
      ? { control:path.join(directory, "control.sock"), data:path.join(directory, "data.sock") }
      : { control:`\\\\.\\pipe\\varin-kernel-${nonce}-control`, data:`\\\\.\\pipe\\varin-kernel-${nonce}-data` };
    const servers = [net.createServer(), net.createServer()];
    const transport = new KernelTransport(endpoints, servers, directory, onFrame, onFailure);
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
    if (this.failed) return Promise.reject(this.failed);
    if (!socket || socket.destroyed) return Promise.reject(new Error("Kernel local connection is unavailable"));
    return new Promise((resolve, reject) => socket.write(bytes, error => error ? reject(error) : resolve()));
  }
  private command(kind: string, id: string, fields: Envelope = {}): Promise<void> {
    return this.write(this.control, controlFrame({ v:KERNEL_PROTOCOL_VERSION, kind, streamId:id, kernelEpoch:this.epoch, ...fields }));
  }
  send(value: Envelope, lane: "control" | "data"): Promise<void> {
    if (lane === "control") return this.write(this.control, controlFrame(value));
    if (this.failed) return Promise.reject(this.failed);
    const id = randomUUID();
    return new Promise<void>((resolve, reject) => {
      this.outgoing.set(id, { id, offset:0, sequence:0, ready:false, waiting:false, aborting:false,
        ...(value.kind === "request" && typeof value.id === "string" ? {requestId:value.id} : {}), resolve, reject });
      this.order.push(id);
      // Announce identity before handing body work to the worker. Native cancellation therefore
      // already has an owner even when encoding is still queued or content is backpressured.
      void this.command("transport-stream-open", id, { identity:identity(value) }).then(() => {
        if (this.outgoing.get(id)?.aborting || !this.outgoing.has(id)) return;
        try { this.worker.postMessage({ type:"encode", id, value }); }
        catch (error) { this.abortOutgoing(id, error instanceof Error ? error : new Error(String(error))); }
      }, error => this.fail(error as Error));
    });
  }
  private abortOutgoing(id: string, error: Error): void {
    const stream = this.outgoing.get(id); if (!stream) return;
    if (stream.aborting) return;
    stream.aborting = true;
    delete stream.bytes;
    this.order = this.order.filter(item => item !== id);
    void this.command("transport-stream-abort", id, {sequence:stream.sequence}).catch(failure => this.fail(failure as Error));
    stream.reject(error);
  }
  cancelRequest(requestId: string): void {
    for (const stream of this.outgoing.values()) {
      if (stream.requestId === requestId) this.abortOutgoing(stream.id, new DOMException("Body transfer cancelled", "AbortError"));
    }
  }
  private fromWorker(message: Envelope): void {
    if (this.failed || this.intentionalClose) return;
    const id = String(message.id);
    if (message.type === "encoded") {
      const stream = this.outgoing.get(id); if (!stream || stream.aborting) return;
      stream.bytes = Buffer.from(message.bytes as ArrayBuffer);
      void this.command("transport-stream-begin", id, { byteLength:stream.bytes.length }).catch(error => this.fail(error as Error));
    } else if (message.type === "ack") {
      void this.command("transport-stream-ack", id, { sequence:message.sequence }).catch(error => this.fail(error as Error));
    } else if (message.type === "decoded") {
      this.onFrame(message.value);
    } else if (message.type === "failed") {
      const error = new Error(`Kernel body ${String(message.operation)} failed: ${String(message.message)}`);
      if (message.operation === "encode") this.abortOutgoing(id, error); else this.fail(error);
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
    if (typeof value.kind !== "string" || !value.kind.startsWith("transport-stream-")) { this.onFrame(value); return; }
    if (value.v !== KERNEL_PROTOCOL_VERSION || value.kernelEpoch !== this.epoch || typeof value.streamId !== "string") throw new Error("Kernel stream epoch or identity mismatch");
    const id = value.streamId;
    const stream = this.outgoing.get(id);
    switch (value.kind) {
      case "transport-stream-open":
        if (this.incoming.has(id) || !value.identity || typeof value.identity !== "object") throw new Error("Invalid incoming stream identity");
        this.incoming.set(id, { identity:value.identity as Envelope, received:0, sequence:0 });
        this.worker.postMessage({ type:"open", id, identity:value.identity }); break;
      case "transport-stream-begin": {
        const received = this.incoming.get(id);
        if (!received || received.length !== undefined || !Number.isSafeInteger(value.byteLength) || Number(value.byteLength) < 0) throw new Error("Invalid incoming stream length");
        received.length = Number(value.byteLength);
        void this.command("transport-stream-ready", id).catch(error => this.fail(error as Error)); break;
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
        this.incoming.delete(id); this.worker.postMessage({ type:"end", id }); break;
      }
      case "transport-stream-abort":
        if (!this.incoming.delete(id)) throw new Error("Unknown aborted stream");
        this.worker.postMessage({ type:"abort", id }); break;
      case "transport-stream-aborted":
        if (!stream?.aborting || value.sequence !== stream.sequence) throw new Error("Invalid aborted stream receipt");
        this.outgoing.delete(id); break;
      default: throw new Error("Unknown kernel transport command");
    }
  }
  private consumeData(body: Buffer): void {
    if (body.length < DATA_HEADER_BYTES) throw new Error("Truncated kernel data frame");
    const hex = body.subarray(0, 16).toString("hex");
    const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    const sequence = Number(body.readBigUInt64BE(16));
    const stream = this.incoming.get(id);
    const payload = body.subarray(DATA_HEADER_BYTES);
    if (!stream || stream.length === undefined || !payload.length || !Number.isSafeInteger(sequence)
      || sequence !== stream.sequence + 1 || payload.length > stream.length - stream.received) throw new Error("Invalid kernel data sequence or length");
    stream.sequence = sequence; stream.received += payload.length;
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
          if (stream?.bytes && !stream.aborting && stream.ready && !stream.waiting) { selected = stream; break; }
        }
        if (!selected?.bytes) break;
        const stream = selected;
        if (stream.offset === stream.bytes!.length) {
          this.outgoing.delete(stream.id); this.order = this.order.filter(id => id !== stream.id);
          await this.command("transport-stream-end", stream.id, { sequence:stream.sequence }); stream.resolve(); continue;
        }
        const chunkBytes = Math.min(this.data!.writableHighWaterMark, KERNEL_MAX_FRAME_BYTES - DATA_HEADER_BYTES);
        const end = Math.min(stream.offset + chunkBytes, stream.bytes!.length);
        const header = Buffer.allocUnsafe(4 + DATA_HEADER_BYTES);
        header.writeUInt32BE(DATA_HEADER_BYTES + end - stream.offset, 0);
        Buffer.from(stream.id.replaceAll("-", ""), "hex").copy(header, 4);
        header.writeBigUInt64BE(BigInt(++stream.sequence), 20);
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
    this.outgoing.clear(); this.incoming.clear(); this.order = [];
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
    this.outgoing.clear(); this.incoming.clear(); this.order = [];
    for (const socket of this.sockets) socket.destroy();
    await Promise.all(this.servers.map(server => new Promise<void>(resolve => { server.close(() => resolve()); })));
    await this.worker.terminate();
    if (this.directory) await fs.rmdir(this.directory).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
  }
}
