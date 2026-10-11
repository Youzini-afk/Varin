import { StringDecoder } from "node:string_decoder";
import type { NestedToolInput, NestedToolReceipt, OutputPart, IncomingMedia } from "@varin/protocol";
import type { ScriptError } from "./core/index.js";

export const SCRIPT_PROTOCOL_VERSION = 2 as const;

interface FrameIdentity {
  v: typeof SCRIPT_PROTOCOL_VERSION;
  environmentId: string;
}

export type ScriptHostFrame = FrameIdentity & (
  | { type: "initialize"; bindingIdentity: string }
  | { type: "eval"; cellId: string; script: string }
  | { type: "receipt"; cellId: string; requestId: string; receipt: NestedToolReceipt }
  | { type: "rejected"; cellId: string; requestId: string; error: ScriptError }
);

export type ScriptWorkerFrame = FrameIdentity & (
  | { type: "ready"; bindingIdentity: string }
  | { type: "invoke"; cellId: string; requestId: string; input: NestedToolInput }
  | { type: "output"; cellId: string; part: OutputPart<IncomingMedia> }
  | { type: "completed"; cellId: string; valueText?: string; error?: ScriptError }
);

export class ScriptProtocolError extends Error {
  readonly code = "SCRIPT_PROTOCOL_ERROR";
  constructor() { super("Invalid script worker protocol frame"); }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function identity(value: unknown): value is Record<string, unknown> & FrameIdentity {
  return object(value) && value.v === SCRIPT_PROTOCOL_VERSION && typeof value.environmentId === "string";
}

function errorShape(value: unknown): value is ScriptError {
  return object(value) && typeof value.message === "string"
    && (value.code === undefined || typeof value.code === "string");
}

export function parseScriptHostFrame(value: unknown): ScriptHostFrame {
  if (!identity(value)) throw new ScriptProtocolError();
  switch (value.type) {
    case "initialize":
      if (typeof value.bindingIdentity === "string") return value as unknown as ScriptHostFrame;
      break;
    case "eval":
      if (typeof value.cellId === "string" && typeof value.script === "string") return value as unknown as ScriptHostFrame;
      break;
    case "receipt":
      // The original protocol owns the receipt union. Do not maintain a second
      // ToolCompletion decoder here; this trusted Host envelope carries it intact.
      if (typeof value.cellId === "string" && typeof value.requestId === "string" && "receipt" in value) return value as unknown as ScriptHostFrame;
      break;
    case "rejected":
      if (typeof value.cellId === "string" && typeof value.requestId === "string" && errorShape(value.error)) return value as unknown as ScriptHostFrame;
      break;
  }
  throw new ScriptProtocolError();
}

function outputPart(value: unknown): boolean {
  if (!object(value)) return false;
  if (value.kind === "text") return typeof value.text === "string" && Object.keys(value).every(key => key === "kind" || key === "text");
  if (value.kind !== "media" || !Object.keys(value).every(key => key === "kind" || key === "media") || !object(value.media)) return false;
  const media = value.media;
  return Object.keys(media).every(key => key === "media_type" || key === "data_base64")
    && typeof media.media_type === "string" && /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(media.media_type)
    && typeof media.data_base64 === "string" && media.data_base64.length > 0
    && Buffer.from(media.data_base64, "base64").toString("base64") === media.data_base64;
}

export function parseScriptWorkerFrame(value: unknown): ScriptWorkerFrame {
  if (!identity(value)) throw new ScriptProtocolError();
  switch (value.type) {
    case "ready":
      if (typeof value.bindingIdentity === "string") return value as unknown as ScriptWorkerFrame;
      break;
    case "invoke":
      // Full JSON input, including unknown fields, reaches the original Rust
      // decoder. This envelope parser is neither a tool list nor an authority.
      if (typeof value.cellId === "string" && typeof value.requestId === "string" && "input" in value) return value as unknown as ScriptWorkerFrame;
      break;
    case "output":
      if (typeof value.cellId === "string" && outputPart(value.part)) return value as unknown as ScriptWorkerFrame;
      break;
    case "completed":
      if (typeof value.cellId === "string" && (value.valueText === undefined || typeof value.valueText === "string")
        && (value.error === undefined || errorShape(value.error))) return value as unknown as ScriptWorkerFrame;
      break;
  }
  throw new ScriptProtocolError();
}

/** Incremental UTF-8 JSONL decoding; no implicit truncation or byte quota. */
export class ScriptFrameDecoder<Frame> {
  readonly #decoder = new StringDecoder("utf8");
  #buffer = "";
  constructor(readonly parse: (value: unknown) => Frame) {}

  push(chunk: Uint8Array | string): Frame[] {
    this.#buffer += typeof chunk === "string" ? chunk : this.#decoder.write(Buffer.from(chunk));
    const frames: Frame[] = [];
    let end: number;
    while ((end = this.#buffer.indexOf("\n")) !== -1) {
      const line = this.#buffer.slice(0, end);
      this.#buffer = this.#buffer.slice(end + 1);
      let value: unknown;
      try { value = JSON.parse(line); } catch { throw new ScriptProtocolError(); }
      frames.push(this.parse(value));
    }
    return frames;
  }

  end(): void {
    this.#buffer += this.#decoder.end();
    if (this.#buffer.length !== 0) throw new ScriptProtocolError();
  }
}

export function encodeScriptFrame(frame: ScriptHostFrame | ScriptWorkerFrame): string {
  return `${JSON.stringify(frame)}\n`;
}
