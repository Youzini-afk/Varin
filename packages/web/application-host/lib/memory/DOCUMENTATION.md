# Memory ownership and Agent personalization

Ordinary Agent memory is explicit, lightweight text. `agent-personalization.ts` owns one
Rust typed record (`agent.personalization`) containing global, project and session notes
and scoped system-prompt edits. Projects use the configured project ID, including its
additional folders. Session notes use the native Pi session ID. There is no implicit
import of old knowledge records or background extraction for ordinary chats.

`agent-memory-services.ts` routes ordinary `memory` calls to this authority. Omitted scope
means the current session; the tool's `user` and `workspace` scopes mean global and project.
The tool cannot read another project's or session's notes. Selected-message saves preserve
the chosen text for user editing without calling the memory organizer. The settings catalog
and authenticated `/api/agent-personalization` routes expose CRUD, scope changes, and prompt
edits. Writes publish only after the Rust receipt. UI edits carry their opened revision;
a conflict stays visible instead of silently overwriting another edit.
The personalization path participates in the production JSON-body middleware for memory saves,
deletes and prompt saves. Its HTTP regression uses that middleware rather than a test-only global parser.

`session.instructions` resolves the actor's current ownership, project, catalog revision and
thread role. Tool presentation uses that identity at the run boundary: ordinary memory has
global/project/session note parameters; Bot memory has provenance and revision-chain parameters.
Main/Worker/read-only Computer and team presentation describes the calling role. A project scope
is only offered when the conversation has a project. Host authorization remains authoritative.

Pi applies global, project, then session prompt section overrides. Matching notes establish a
system memory snapshot when the first run starts. The snapshot and its system sections are recorded in the native Pi branch;
it stays unchanged while memory mutations arrive at the conversation tail. Direct memory results
carry saved text/deletion and the committed revision. Nested calls, including Codemode, forward
the same receipts through the enclosing tool result without relying on the script to print them.
External/UI changes are retained as `varin-memory` messages only after the provider starts responding;
failed requests retry undelivered changes. Per-entry receipt revisions handle out-of-order parallel
results. Writes still commit immediately to the Rust authority; new conversations see current notes.

A successful compaction stores the new `agentMemorySnapshot` and effective `systemMessage` in the same native compaction entry.
Request-boundary capacity validation includes the new snapshot before publication. Preparing, cancelling or failing a
summary never advances the snapshot. Reopening or navigating a branch reconstructs its checkpoint
and delivered changes from Pi history; this is not another memory database. The next request renders
the stored snapshot and appends any newer changes. Deleting the last note removes every memory section
at the next committed snapshot. Compaction can change the cached prefix; this design avoids memory
mutations rewriting that prefix between compactions, without promising provider cache hits.

Unchanged official sections continue to follow the runtime;
explicit edits remain user-owned. Reset removes only that scope's overrides. `SYSTEM.md`,
`APPEND_SYSTEM.md`, project instructions, extensions and skills retain native Pi loading.
The settings page shows the current memory snapshot in the assembled preview and the last system text observed at
the actual model-request boundary. The latter is an in-memory observation of an attempted
request, not evidence of provider delivery, and is lost when the worker stops.

Bot ownership is determined by the Host registry, not a caller-supplied mode. Bot requests
never receive Agent prompt overrides or Agent notes. Bot memory continues through
`memory-service.ts`, Bot/user knowledge stores, `recall`, and the optional organizer.
The organizer only enumerates Bots; ordinary context assembly bypasses knowledge recall.
Plans, observations, materials, symbol indexing and other knowledge-store users remain intact.

The old Magic Prompts, prompt-template resource editor/expansion and ordinary knowledge
catalog are removed. Product actions use `actionInstructions.ts`; native skills remain
editable resources. Existing user-owned prompt files are not deleted, but Varin no longer
loads them as command templates.

Verification owners: `agent-personalization.native.test.ts` exercises real Rust persistence,
scope isolation and stale edits; Pi `session-e2e.test.ts` exercises actual outgoing requests
with a faux provider; UI `AgentSettings.behavior.test.tsx` covers editing and scope selection.


Native conversations now read this same catalog through `kernel/native-thread-context.ts` at first
input admission. Rust atomically stores the resulting system snapshot alongside the native input;
project scope comes from Host-admitted workspace membership and session scope is the native thread ID.
The checkpoint carries the typed original-section and scope basis through subsequent Runs, explicit
compaction and conversation forks. Committed note/profile edits trigger Host refresh through this
same catalog; later admission and resume also await refresh. Native refresh CAS replaces only the
system snapshot and its provenance, preserving any summary and original tail, and never rewrites
prepared/dispatched ModelStep requests. Removing notes and resetting profiles re-render from the
original sections. Failed refreshes are retried at later admission rather than treated as delivered.
The Pi tail-message mutation/receipt and cache-prefix behavior above remains Pi-specific. Native
memory tools are not implied, and no native memory catalog is added.
