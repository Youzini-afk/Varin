import type { WireEnvelope } from "./envelopes.js";
import { isHostEvent } from "./events.js";
import {
  isRuntimeEventEnvelope,
  isRuntimeMethod,
  type RuntimeWireEnvelope,
} from "./runtime.js";
import { type JsonValue, VARIN_PROTOCOL_VERSION } from "./types.js";

export class ProtocolDecodeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ProtocolDecodeError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ProtocolDecodeError("invalid_envelope", `${field} must be a non-empty string`);
  }
}

export function decodeEnvelope(frame: string): WireEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(frame);
  } catch {
    throw new ProtocolDecodeError("invalid_json", "Protocol frame is not valid JSON");
  }

  return validateEnvelope(value);
}

/** Validate a value already decoded from JSON, including a Node IPC message. */
export function validateEnvelope(value: unknown): WireEnvelope {
  if (!isRecord(value)) {
    throw new ProtocolDecodeError("invalid_envelope", "Protocol frame must be a JSON object");
  }
  if (value.v !== VARIN_PROTOCOL_VERSION) {
    throw new ProtocolDecodeError(
      "unsupported_version",
      `Unsupported protocol version: ${String(value.v)}`,
    );
  }

  switch (value.kind) {
    case "request":
      requireNonEmptyString(value.id, "id");
      requireNonEmptyString(value.method, "method");
      if (!("params" in value)) {
        throw new ProtocolDecodeError("invalid_envelope", "request.params is required");
      }
      break;
    case "response":
      requireNonEmptyString(value.id, "id");
      if (typeof value.ok !== "boolean") {
        throw new ProtocolDecodeError("invalid_envelope", "response.ok must be a boolean");
      }
      if (value.ok && !("result" in value)) {
        throw new ProtocolDecodeError("invalid_envelope", "successful response.result is required");
      }
      if (!value.ok && !isRecord(value.error)) {
        throw new ProtocolDecodeError("invalid_envelope", "failed response.error is required");
      }
      break;
    case "event":
      requireNonEmptyString(value.event, "event");
      if (!Number.isSafeInteger(value.seq) || Number(value.seq) < 0) {
        throw new ProtocolDecodeError(
          "invalid_envelope",
          "event.seq must be a non-negative integer",
        );
      }
      if (!("data" in value)) {
        throw new ProtocolDecodeError("invalid_envelope", "event.data is required");
      }
      break;
    default:
      throw new ProtocolDecodeError("invalid_envelope", "Unknown protocol envelope kind");
  }

  return value as WireEnvelope;
}

export function encodeEnvelope(envelope: WireEnvelope): string {
  return `${JSON.stringify(envelope)}\n`;
}

/** Decode one frame received from a Varin surface transport. */
export function decodeRuntimeEnvelope(frame: string): RuntimeWireEnvelope {
  const envelope = decodeEnvelope(frame);
  if (envelope.kind === "request" && !isRuntimeMethod(envelope.method)) {
    throw new ProtocolDecodeError(
      "unsupported_method",
      `Unsupported runtime method: ${String(envelope.method)}`,
    );
  }
  if (envelope.kind === "event" && !isRuntimeEventEnvelope(envelope)) {
    throw new ProtocolDecodeError("invalid_envelope", "runtime event.source is required");
  }
  if (envelope.kind === "event" && !isHostEvent(envelope.event)) {
    throw new ProtocolDecodeError(
      "unsupported_event",
      `Unsupported runtime event: ${String(envelope.event)}`,
    );
  }
  return envelope as RuntimeWireEnvelope;
}

/** Encode one message-oriented surface frame (WebSocket/postMessage). */
export function encodeRuntimeEnvelope(envelope: RuntimeWireEnvelope): string {
  return JSON.stringify(envelope);
}

export interface JsonLineDecoderOptions {
  /** Set a positive byte count to cap frames. Omit, null, or 0 for no artificial cap. */
  maxFrameBytes?: number | null;
}

export class JsonLineDecoder {
  readonly #decoder = new TextDecoder();
  readonly #encoder = new TextEncoder();
  readonly #maxFrameBytes: number | undefined;
  #buffer = "";

  constructor(options: JsonLineDecoderOptions = {}) {
    const configured = options.maxFrameBytes;
    this.#maxFrameBytes = configured === undefined || configured === null || configured === 0
      ? undefined
      : configured;
    if (
      this.#maxFrameBytes !== undefined &&
      (!Number.isSafeInteger(this.#maxFrameBytes) || this.#maxFrameBytes < 0)
    ) {
      throw new RangeError("maxFrameBytes must be a non-negative integer, null, or undefined");
    }
  }

  push(chunk: string | Uint8Array): WireEnvelope[] {
    this.#buffer +=
      typeof chunk === "string" ? chunk : this.#decoder.decode(chunk, { stream: true });
    this.#assertWithinLimit();

    const envelopes: WireEnvelope[] = [];
    let newline = this.#buffer.indexOf("\n");
    while (newline !== -1) {
      let frame = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (frame.endsWith("\r")) frame = frame.slice(0, -1);
      if (frame.length > 0) envelopes.push(decodeEnvelope(frame));
      this.#assertWithinLimit();
      newline = this.#buffer.indexOf("\n");
    }
    return envelopes;
  }

  finish(): WireEnvelope[] {
    this.#buffer += this.#decoder.decode();
    if (this.#buffer.length === 0) return [];
    this.#assertWithinLimit();
    const frame = this.#buffer.endsWith("\r") ? this.#buffer.slice(0, -1) : this.#buffer;
    this.#buffer = "";
    return frame.length === 0 ? [] : [decodeEnvelope(frame)];
  }

  #assertWithinLimit(): void {
    if (
      this.#maxFrameBytes !== undefined &&
      this.#encoder.encode(this.#buffer).byteLength > this.#maxFrameBytes
    ) {
      this.#buffer = "";
      throw new ProtocolDecodeError(
        "frame_too_large",
        "Protocol frame exceeds the configured limit",
      );
    }
  }
}

export function asJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
