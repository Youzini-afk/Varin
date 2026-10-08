# Pi session automation

Conversation titles, Goal continuation and post-turn assistance use Varin's Pi
runtime contract. They do not call OpenCode endpoints and do not maintain a
second session model.

## Conversation titles

`titles.ts` requests a short title from the configured small model after a user message
is accepted into an unnamed session. It sends the first text-bearing user message through
the existing small-model resolver, independently of the agent run. The system prompt is
`SESSION_TITLE_SYSTEM_PROMPT`; neither this request nor its response enters agent context.
The title is persisted through native Pi `session.rename` with `onlyIfUnnamed`, checked at
the write so a manual rename takes precedence. Name snapshots also update the UI catalog.

Duplicate message and settled events share one request. A failure leaves the first-message
display fallback intact and can retry on the next user message; opening the session list
does not generate titles in bulk. Closing the session or replacing its worker cancels the
request. Named child threads and scheduled sessions retain their assigned names.

## State ownership

`@varin/pi-host` stores `PiSessionFeatureState` as append-only custom
entries named `varin.session-features/v1` in the Pi session JSONL. The
entries do not participate in model context. Because each update is a normal
tree entry, Goal and Assist states follow conversation branches and are restored
by Pi navigation.

The renderer receives the state on every `session.snapshot` and mutates it
through `session.features.mutate`. The broker and host both parse this union
into a narrow payload before forwarding it.

## Goal loop

Starting a goal records the objective and the current cumulative Pi token
count as its baseline before the first prompt is dispatched. While the goal
is active, the hidden Pi host extension appends the objective to the effective
system prompt through `before_agent_start`.

After `agent_settled`, the server waits for the quiet window and reads a fresh
snapshot, branch entries, stats, and feature state from the broker. It then:

1. accounts `session.stats.tokens.total - goal.tokenBaseline`;
2. applies hard stops for errors, aborts, token budget, and the continuation
   cap;
3. sends the objective and latest agent reply to the small model for a reported-progress verdict
   (`continue`, `complete`, or `blocked`);
4. requires three consecutive blocked verdicts and stops after two
   consecutive audit failures;
5. persists progress before dispatching the next `agent.prompt`.

Goal-ID guards in the host reject a delayed audit after the user has replaced
or cleared the goal. The tail entry is checked again after the model call so a
new user message wins over an automatic continuation. Per-turn completion
notifications are suppressed while the goal is active; a settled goal sends
one final completion or attention notification. This verdict is based on the supplied report;
workspace inspection and validation remain part of the original work. Automatic continuation
carries the objective and runtime budget/counters without a prescribed workflow or report format.

## Next-message suggestions

When next-step suggestions are enabled, the configured `harness.models.nextStep` model
receives excerpts from the recent user messages and latest agent reply, plus any available
failure and goal-state facts. Its JSON `suggestions` array contains editable next user messages;
an empty array is valid. Suggestions are stored with the assistant entry ID. The renderer shows
them only while that entry is still the latest completed assistant reply, so a new user message
invalidates stale assistance without a clearing write.

## Tests

- `packages/pi-host/test/session-features.test.ts` covers persistence,
  branching, stale writes, and the Goal prompt hook.
- `packages/web/application-host/lib/pi-session-automation/runtime.test.ts` covers Goal
  settlement/continuation and Assist writes.
- `packages/runtime-broker/test/runtime-broker.test.ts` exercises the feature
  RPC through real catalog and session workers.
