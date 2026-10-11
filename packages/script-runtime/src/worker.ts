import type { NestedToolReceipt } from "@varin/protocol";
import { createNodeReplSession, type NodeReplSession } from "./core/index.js";
import { encodeScriptFrame, parseScriptHostFrame, ScriptFrameDecoder, ScriptProtocolError, type ScriptHostFrame, type ScriptWorkerFrame } from "./frames.js";

// This entry point evaluates inside the process already owned by the guardian.
// It does not create a second worker/process or report physical-stop evidence.
let session: NodeReplSession | undefined;
let nextRequestId = 0n;
let ended = false;
const pending = new Map<string, {
  cellId: string;
  resolve(receipt: NestedToolReceipt): void;
  reject(error: Error): void;
}>();

function send(frame: ScriptWorkerFrame): void {
  if (ended) throw new Error("Script transport is closed");
  process.stdout.write(encodeScriptFrame(frame));
}

function disconnect(protocolError: boolean): void {
  if (ended) return;
  ended = true;
  session?.closeAdmission();
  const error = Object.assign(new Error("Script transport is closed"), { code: "SCRIPT_TRANSPORT_CLOSED" });
  for (const request of pending.values()) request.reject(error);
  pending.clear();
  process.stdin.destroy();
  if (protocolError) {
    // Never echo incoming JSON, script text, tool parameters, or exception stacks.
    process.stderr.write("Script worker protocol failed\n");
    process.exitCode = 1;
  }
  // EOF and exitCode are local transport facts only. The guardian still owns
  // process-tree termination, especially when detached timers keep Node alive.
}

function receive(frame: ScriptHostFrame): void {
  if (ended) return;
  if (!session) {
    if (frame.type !== "initialize") throw new ScriptProtocolError();
    const environmentId = frame.environmentId;
    session = createNodeReplSession({
      environmentId,
      invoke(cellId, input) {
        const requestId = String(++nextRequestId);
        return new Promise<NestedToolReceipt>((resolve, reject) => {
          pending.set(requestId, { cellId, resolve, reject });
          try { send({ v: 1, type: "invoke", environmentId, cellId, requestId, input }); }
          catch (error) { pending.delete(requestId); reject(error); }
        });
      },
      output(cellId, text) { send({ v: 1, type: "output", environmentId, cellId, text }); },
    });
    send({ v: 1, type: "ready", environmentId, bindingIdentity: frame.bindingIdentity });
    return;
  }
  if (frame.environmentId !== session.environmentId || frame.type === "initialize") throw new ScriptProtocolError();
  if (frame.type === "eval") {
    void session.evaluate(frame).then((result) => {
      if (!ended) send({ v: 1, type: "completed", environmentId: frame.environmentId, cellId: frame.cellId, ...result });
    }).catch(() => disconnect(true));
    return;
  }
  const request = pending.get(frame.requestId);
  if (!request || request.cellId !== frame.cellId) throw new ScriptProtocolError();
  pending.delete(frame.requestId);
  if (frame.type === "receipt") request.resolve(frame.receipt);
  else request.reject(Object.assign(new Error(frame.error.message), frame.error.code === undefined ? {} : { code: frame.error.code }));
}

const decoder = new ScriptFrameDecoder(parseScriptHostFrame);
process.stdin.on("data", (chunk: Buffer) => {
  try { for (const frame of decoder.push(chunk)) receive(frame); }
  catch { disconnect(true); }
});
process.stdin.on("end", () => {
  try { decoder.end(); disconnect(false); }
  catch { disconnect(true); }
});
process.stdin.on("error", () => disconnect(true));
process.stdout.on("error", () => disconnect(true));
