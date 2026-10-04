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

`session.instructions` resolves the actor's current ownership on each model request.
Pi applies global, project, then session prompt section overrides and includes all matching
notes as named system sections. Unchanged official sections continue to follow the runtime;
explicit edits remain user-owned. Reset removes only that scope's overrides. `SYSTEM.md`,
`APPEND_SYSTEM.md`, project instructions, extensions and skills retain native Pi loading.
The settings page shows the complete assembled preview and the last system text observed at
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
