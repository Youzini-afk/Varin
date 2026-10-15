# Script runtime

`@varin/script-runtime` owns the shared Node REPL evaluator and the private JSONL
transport for an explicitly selected, Run-owned script environment. It uses only
Node built-ins at runtime; the `@varin/protocol` dependency supplies generated types.

The Application Host owns environment selection, frozen binding identity, cell
queuing and original nested-tool dispatch. The existing process/guardian owner
launches and stops the Node process and records its real process-tree evidence.
This package does not implement another Run, receipt database, permission list,
process supervisor, OS sandbox, or physical-stop authority. A Node REPL context or
worker alone does not constrain arbitrary Node I/O.

## Shared evaluator

```ts
import { createNodeReplSession } from '@varin/script-runtime';

const session = createNodeReplSession({
  environmentId,
  invoke: (cellId, input) => invokeOriginalTool(cellId, input),
  output: (cellId, text) => publishOutput(cellId, { kind: 'text', text }),
  outputPart: (cellId, part) => publishOutput(cellId, part),
});
const result = await session.evaluate({ cellId, script });
// { valueText?: string, error?: { message: string, code?: string } }
```

Each session has its own Node `REPLServer` context. Node owns parsing, top-level
await, returned-Promise resolution and persistent `let`, `const`, class, function,
closure and object state. There is no `AsyncFunction`/globals-dictionary substitute.
Launch the containing Node process with `--experimental-repl-await` so its flags cannot silently
disable that contract. The package requires Node >=22.19.0.

The default context supplies `tools.invoke(input)`, `print(...values)`, `emitImage(image)`
and a Node `console` whose output is associated with the calling cell. Print/console
values remain ordinary text previews (`inspect` depth 6 for non-strings). Only explicit
`emitImage({ media_type, data_base64 })` publishes an image part; its base64 must be
canonical and non-empty. A resolved image from an original nested tool receipt can
be passed directly. The evaluator takes only those byte fields; the runtime assigns
the outer invocation's original source when it accepts the output. Storage hashes,
paths and URLs cannot authorize an image read.

Text and image parts retain emission order, including parts accepted before a failed
cell. The JSON result data and optional `valueText` remain separate from these parts.
Nested tool images stay in their original receipts until the caller explicitly emits
a selected image. Neither printing a lookalike object nor returning one infers media,
and forwarding an image does not manufacture a nested model tool/result exchange.
The Host supplies `outputPart` for typed output; a custom embedding without it gets
an explicit error from `emitImage`, rather than silently losing an image.

A trusted embedding can use `createNodeReplSession<Input, Receipt>` and the optional
`install({ context, invoke, output })` hook to install its SDK. Supplying `install` replaces the default
`tools` and `emitImage` installation; `print` and `console` remain available. The embedding owns its
method/argument and error mapping rather than maintaining another lexical engine.
A third optional `ErrorInfo extends ScriptError` type parameter and `serializeError(error)` allow an
explicit error projection. Native transport preserves message/code; a failing custom projection falls
back to the base error. These hooks are trusted embedding code, not authority for script authors to
change the original Run or its permissions.

`invoke` and output always read their real `AsyncLocalStorage` scope. A function
saved in an earlier cell uses the scope of its current caller. Timers and Promise
continuations inherited from an ended cell remain fenced, even while a later cell
is running. Evaluation completion first closes admission synchronously and then
waits for every already-admitted invocation to settle. This includes unawaited
calls and calls admitted before a script error. Rejected calls remain rejected
Promises, never synthetic tool receipts. The Host independently drains its actual
original invocations.

Concurrent `evaluate` calls return `SCRIPT_ENVIRONMENT_BUSY`; the Host queues cells.
`closeAdmission()` permanently fences this session and all inherited scopes and
releases REPL input/output machinery. It does not abort an in-flight JavaScript
Promise, clear detached timers, stop subprocesses, or prove any external effect
stopped. The original guardian owns synchronous-loop/process-tree termination.

### Known upstream REPL edge case

On the tested Node 24.19.0, `await Promise.reject(null)` reaches Node's public eval
callback as `(null, undefined)`, the same as successful `await
Promise.resolve(undefined)`. The default REPL loses this distinction before this
package receives it. Direct `throw null`, returned `Promise.reject(null)`, and
undefined/false/zero rejections are preserved as failures by this package. This
remaining top-level-await/null case is not a passing error-preservation claim.
The finite `test/repl-null-rejection-probe.mjs` reproduces it directly against
`node:repl`, without this evaluator. No internal parser patches, second evaluator,
source rewriting, or global Promise changes are used to conceal the limitation.

## Frozen worker entry point

The Host resolves `import.meta.resolve('@varin/script-runtime/worker')` from its
installed package graph and fixes that compiled entry point in the original
managed-process launch. Run that entry point with Node and
`--experimental-repl-await`. Evaluation occurs directly in this already-managed
process; it does not spawn an extra worker or supervisor.

All frames are UTF-8 JSON objects followed by `\n`, with `v: 2` and `environmentId`.
The package root exports the shared frame types, encoder and incremental decoder:

- Host → `initialize { bindingIdentity }`, `eval { cellId, script }`,
  `receipt { cellId, requestId, receipt }`,
  `rejected { cellId, requestId, error: { message, code? } }`
- Worker → `ready { bindingIdentity }`, `invoke { cellId, requestId, input }`,
  `output { cellId, part }`, `completed { cellId, valueText?, error? }`

Output parts use the generated `OutputPart<IncomingMedia>` union. The frame parser
checks the private envelope and inline bytes; Rust owns persistence, source attribution
and the original invocation receipt. Older private protocol versions fail explicitly.

Initialization fixes one environment and echoes the Host's string binding identity.
Wrong-environment frames, repeated initialization, malformed envelopes and responses
without their exact pending cell/request pair fail the transport. Request IDs are
unique increasing decimal strings for that process/environment instance. They are
separate from semantic `input.callId`: concurrent identical retries have different
transport promises and retain their original receipts.

`NestedToolInput` and `NestedToolReceipt` are imported from generated protocol
types. The envelope decoder forwards complete JSON input, including unknown
fields, to the original Rust decoder; it does not maintain a second tool/permission
list or argument-field whitelist. Trusted Host receipts pass through intact;
this transport does not duplicate the generated completion union or validate its
meaning as a second authority. Host `rejected` frames are transport/call errors,
not replacements for original completion facts.

Stdout is reserved for protocol frames. The provided `print` and `console` emit
`output` frames; Node's own REPL prompts/domain diagnostics go to a discarded
internal stream. Direct `process.stdout`, writes to file descriptor 1, and imported
logging code that bypasses the installed console are outside this protocol and
can corrupt it. Callers needing ordinary process diagnostics must use stderr.
Neither the context nor stream convention is a security boundary. Transport
failures write only a fixed diagnostic, without echoing script bodies, parameters,
raw input or exception stacks. No arbitrary input/output byte cap is imposed.

EOF fences admission and rejects local pending promises; it emits no completion or
stop claim. Detached work can still keep the process alive. Errors, `completed`,
EOF and process exit are not process-tree-stop evidence. The Host may project loss
locally while the guardian independently establishes actual termination.

## Verification

From the repository root, with the normal Node/Bun toolchain prepared:

```sh
bun run --cwd packages/script-runtime test
bun run --cwd packages/script-runtime type-check
bun run --cwd packages/script-runtime lint
```

`test` builds this package before the real Node stdio subprocess suite.
`test:dist` consumes existing compiled output and does not build it. The package
build references the already-generated protocol declarations, so build
`@varin/protocol` first when those declarations are absent or changed.

The focused tests cover lexical/TLA/closure/object persistence, separate contexts,
error recovery, async-scope fencing, actual invocation drain, compiled worker
framing and EOF, unchanged input forwarding, and concurrent same-callId transport
requests. These are evaluator/transport tests, not guardian/Host cancellation,
OS isolation, physical desktop, external network, provider or product-E2E evidence.
