import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeScriptFrame, parseScriptHostFrame, parseScriptWorkerFrame, ScriptFrameDecoder, ScriptProtocolError } from "../src/index.js";

test("incremental JSONL preserves split UTF-8 and complete nested input", () => {
  const rawInput = { callId: "语义", name: "example", arguments: { text: "文字🙂", list: [1, null] }, unknownFieldForRust: true };
  const frame = parseScriptWorkerFrame({ v: 1, type: "invoke", environmentId: "e", cellId: "c", requestId: "transport", input: rawInput });
  assert.equal(frame.type, "invoke");
  const bytes = Buffer.from(encodeScriptFrame(frame));
  const decoder = new ScriptFrameDecoder(parseScriptWorkerFrame);
  const found = [...bytes].flatMap((byte) => decoder.push(Buffer.from([byte])));
  decoder.end();
  assert.deepEqual(found, [frame]);
  assert.equal(frame.type === "invoke" ? frame.input : undefined, rawInput);
});

test("invalid envelopes and truncated frames fail without copying sensitive payload into errors", () => {
  const secretLookingMarker = "do-not-echo-parameters";
  const decoder = new ScriptFrameDecoder(parseScriptHostFrame);
  assert.throws(() => decoder.push(`${secretLookingMarker}\n`), (error: unknown) => {
    assert.ok(error instanceof ScriptProtocolError);
    assert.equal(error.message.includes(secretLookingMarker), false);
    return true;
  });
  assert.throws(() => parseScriptWorkerFrame({ v: 2, type: "ready", environmentId: "e", bindingIdentity: "b" }), ScriptProtocolError);
  const truncated = new ScriptFrameDecoder(parseScriptHostFrame);
  truncated.push('{"v":1');
  assert.throws(() => truncated.end(), ScriptProtocolError);
});
