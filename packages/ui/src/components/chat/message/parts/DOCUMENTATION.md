# Chat message presentation helpers

The current Pi timeline is rendered by `components/pi-session/PiTimelineEntries.tsx`.
This directory holds shared parsing, summaries and small presentation helpers; it no longer owns
the former `MessageBody`, `ProgressiveGroup`, or `ToolPart` renderer components.

## Current owners

- `toolSummary.ts` produces compact tool descriptions from arguments and structured details.
  `PiTimelineEntries` uses these summaries and groups consecutive read-only calls; writes and shell
  execution stay separate. Keep model-facing output distinct from presentation metadata.
- `toolOutput.ts` normalizes terminal control sequences and computes streamed appends versus
  rewritten snapshots. Its helper tests cover authoritative output, transient bash output and
  bounded handling of terminal cursor coordinates.
- `toolDiffUtils.ts` holds file-change/diff helpers.
- `generatedJsonResult.ts` and `JsonSummaryView.tsx` handle structured-result recognition and
  compact JSON presentation; `../toolRenderers.tsx` owns shared output parsing.
- `userTextPartContent.ts` recognizes known native skill invocations and attachment links.
  Unknown bare slash text must stay ordinary text.
- `taskSessionIdParser.ts` parses task-tag identities from text. It is not an authority for matching
  live child sessions by title, order, or timestamp.

Some helpers remain covered by historical test filenames such as `ToolPart.test.ts`; a test filename
is not evidence that the corresponding old renderer still exists. Inspect live consumers before
changing presentation. Do not restore removed OpenCode message contracts or a tool-specific
OpenChamber renderer.

## Timeline projection

The Pi timeline reuses its immutable history projection while live text changes.
Its virtual-list rows retain their array identity during text deltas; one separate
live item supplies the current payload to the mounted row and explicit chat actions.
New persisted entries or live tool-call identities rebuild the history projection;
completed virtual rows keep their item identity. Live tool results reuse the
unchanged persistent source and are refreshed on result or call membership changes.
Projection source state is weakly owned by the prior view result and is released
with that view, not accumulated in a global history cache.

Prompt navigation projects only structural row changes and reads prompt text only
while its menu is open. Streaming must not rebuild closed menu elements or run
full-history anchor lookups. `PiTimeline.streaming.test.tsx` exercises 2,000 turns
and 100 live updates with deterministic history-read and list-data identity checks.
Set `VARIN_PERF_UI=1` when running that focused test to print the isolated component
timing; it is not a browser frame-rate or packaged-desktop measurement.

## Verification

Use the focused UI package tests for the behavior being changed, for example:

```sh
bun run --cwd packages/ui test src/components/chat/message/parts/toolSummary.test.ts
```

For timeline behavior, include its actual Pi timeline consumers. Choose broader type, lint or build
checks when the change reaches shared contracts or bundling; simple copy edits do not need a full
product build.
