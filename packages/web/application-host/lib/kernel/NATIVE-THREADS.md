# Native thread Application Host consumer

`native-thread-adapter.ts` admits explicitly selected `nativeThread` identities through the
existing Application Host. It never creates, opens or writes a Pi session. Rust owns the
thread/branch, history, queue, Run, Operation and durable events. The Host holds no second
conversation store. `native-thread-routes.ts` uses the same authentication middleware as
other Application Host routes; `@varin/application-client` owns its framework-neutral API
and HTTP consumer, installed on Web RuntimeAPIs (including the Web surface in Electron).

Create accepts a stable client request key and derives a namespaced identity. Submit accepts
only a registered provider/model choice, text, expected head and an optional fixed source
selection. Model endpoints and secrets come from the existing credential authority. Source
selection does not grant capabilities: the Host validates its workspace and the kernel binds
fresh grants to the selected revision. Receipt acceptance is distinct from asynchronous
source materialization and execution. A preparation failure records a safe durable failure code and preparation Wait for explicit
resume; it is not reported as successful execution. Startup rebinds eligible saved launches
through the same current credential owner; an unresolved model/effect Wait remains blocked.

Observe installs a native notification listener before reading durable events. Presentation
progress is transient; replay reads committed events after the caller's cursor. Consumers
must preserve the last delivered durable cursor and reconnect after stream close, then
refresh snapshots after a progress sequence gap. A slow SSE socket is closed rather than
holding unbounded event buffers. Disconnect does not cancel accepted work. Run/Operation
cancellation returns the authority's actual cancellation/effect state; it does not fabricate
completion of background processes. Operation inspection exposes actual handoff/external
receipt facts.

The Agent workbench has an explicit nativeThread selector using the shared layout and Markdown
renderer. Its projection controller reconstructs durable history, queue and operation facts and
keeps transient progress separate. This is a vertical integration, not Pi parity. Default main-chat
cutover, multimodal input, compaction, memory, questions, goal/schedule domains, MCP/extension routing,
remote environments, Pi asset import and final Pi removal still require their named owners.
Next-run admission uses the saved launch credential scope and the core environment-owner reference
to retain a materialized directory, rather than resetting files to the original source. Independent
verification owns the restart, source-continuity and HTTP acceptance evidence. No public model endpoint,
credential, grant or arbitrary kernel-method passthrough is accepted by these routes.

Initial input acceptance, source/credential selection and receipt are committed atomically by the
native submit-with-launch path. Successor input likewise inherits the nonsecret selection in its
admission transaction; Host restart reacquires current grants against that saved selection. These
recovery contracts require the independent crash/reopen evidence; they do not imply replay of
already-dispatched provider requests or unknown external effects.

Independent acceptance in `native-thread-http-review.native.test.ts` uses the public HTTP client,
authenticated Express routes, real kernel and loopback model service. It covers atomic initial
credential pinning, completed-submit retry without a second provider call, stable create retry,
history/SSE, mismatched thread/branch rejection, queued input edit/cancel, active cancellation and
credential-bound next-run completion. It uses fake credentials and proves no live-provider parity.
