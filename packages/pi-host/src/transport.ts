import { isCredentialStoreResponse } from './credential-store-rpc.js';
import {
  encodeEnvelope,
  JsonLineDecoder,
  validateEnvelope,
  type WireEnvelope,
} from "@varin/protocol";
import { createDeferred } from "./deferred.js";

export type EnvelopeHandler = (envelope: WireEnvelope) => void;
export type TransportErrorHandler = (error: unknown) => void;

export interface HostTransport {
  close(): void;
  send(envelope: WireEnvelope): void;
  start(handler: EnvelopeHandler, onClose?: () => void, onError?: TransportErrorHandler): void;
}

export class IpcHostTransport implements HostTransport {
  #messageHandler: ((message: unknown) => void) | undefined;
  #disconnectHandler: (() => void) | undefined;

  start(handler: EnvelopeHandler, onClose?: () => void, onError?: TransportErrorHandler): void {
    if (this.#messageHandler) throw new Error("IPC transport is already started");
    this.#messageHandler = (message) => {
      // Private secret-bearing owner replies are handled by RemoteCredentialStore, never public RPC.
      if (isCredentialStoreResponse(message)) return;
      try {
        handler(validateEnvelope(message));
      } catch (error) {
        onError?.(error);
      }
    };
    this.#disconnectHandler = () => onClose?.();
    process.on("message", this.#messageHandler);
    process.on("disconnect", this.#disconnectHandler);
  }

  send(envelope: WireEnvelope): void {
    if (!process.send || !process.connected) throw new Error("Node IPC channel is not connected");
    process.send(envelope);
  }

  close(): void {
    if (this.#messageHandler) process.off("message", this.#messageHandler);
    if (this.#disconnectHandler) process.off("disconnect", this.#disconnectHandler);
    this.#messageHandler = undefined;
    this.#disconnectHandler = undefined;
    if (process.connected) process.disconnect?.();
  }
}

export class StdioHostTransport implements HostTransport {
  readonly #decoder = new JsonLineDecoder();
  #dataHandler: ((chunk: Buffer) => void) | undefined;
  #endHandler: (() => void) | undefined;

  start(handler: EnvelopeHandler, onClose?: () => void, onError?: TransportErrorHandler): void {
    if (this.#dataHandler) throw new Error("stdio transport is already started");
    this.#dataHandler = (chunk) => {
      try {
        for (const envelope of this.#decoder.push(chunk)) handler(envelope);
      } catch (error) {
        onError?.(error);
      }
    };
    this.#endHandler = () => {
      try {
        for (const envelope of this.#decoder.finish()) handler(envelope);
      } catch (error) {
        onError?.(error);
      }
      onClose?.();
    };
    process.stdin.on("data", this.#dataHandler);
    process.stdin.on("end", this.#endHandler);
    process.stdin.resume();
  }

  send(envelope: WireEnvelope): void {
    process.stdout.write(encodeEnvelope(envelope));
  }

  close(): void {
    if (this.#dataHandler) process.stdin.off("data", this.#dataHandler);
    if (this.#endHandler) process.stdin.off("end", this.#endHandler);
    this.#dataHandler = undefined;
    this.#endHandler = undefined;
    process.stdin.pause();
  }
}

export class MemoryHostTransport implements HostTransport {
  readonly sent: WireEnvelope[] = [];
  #handler: EnvelopeHandler | undefined;
  #onClose: (() => void) | undefined;
  #onError: TransportErrorHandler | undefined;
  #waiters = new Set<() => void>();

  start(handler: EnvelopeHandler, onClose?: () => void, onError?: TransportErrorHandler): void {
    this.#handler = handler;
    this.#onClose = onClose;
    this.#onError = onError;
  }

  send(envelope: WireEnvelope): void {
    this.sent.push(envelope);
    for (const wake of this.#waiters) wake();
  }

  receive(envelope: WireEnvelope): void {
    if (!this.#handler) throw new Error("Memory transport is not started");
    this.#handler(envelope);
  }

  fail(error: unknown): void {
    if (!this.#onError) throw new Error("Memory transport has no error handler");
    this.#onError(error);
  }

  async waitFor(
    predicate: (envelope: WireEnvelope) => boolean,
    timeoutMs: number = 5_000,
  ): Promise<WireEnvelope> {
    const existing = this.sent.find(predicate);
    if (existing) return existing;
    const deferred = createDeferred<WireEnvelope>();
    const timeout = setTimeout(
      () => deferred.reject(new Error(`Timed out waiting for host envelope after ${timeoutMs}ms`)),
      timeoutMs,
    );
    const wake = () => {
      const match = this.sent.find(predicate);
      if (!match) return;
      clearTimeout(timeout);
      this.#waiters.delete(wake);
      deferred.resolve(match);
    };
    this.#waiters.add(wake);
    return deferred.promise;
  }

  close(): void {
    this.#handler = undefined;
    this.#onError = undefined;
    const onClose = this.#onClose;
    this.#onClose = undefined;
    onClose?.();
  }
}

export function createProcessTransport(forceStdio: boolean = false): HostTransport {
  return !forceStdio && typeof process.send === "function"
    ? new IpcHostTransport()
    : new StdioHostTransport();
}
