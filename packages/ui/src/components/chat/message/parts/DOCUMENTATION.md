# Chat message presentation helpers

Native conversation rendering lives in `components/thread/ThreadConversation.tsx`, `ThreadContent.tsx`
and `ThreadMedia.tsx`. This directory contains parsing, summaries and small presentation helpers; it
does not own a conversation runtime or a separate history store. Check real consumers before extending
a helper: the presence of a module or historical test filename does not establish use by the Thread UI.

## Helpers

- `toolSummary.ts` builds compact tool descriptions and grouping metadata.
- `toolOutput.ts` normalizes terminal control sequences and distinguishes streamed appends from
  rewritten snapshots. Its tests cover authoritative output and bounded terminal cursor coordinates.
- `toolDiffUtils.ts` holds file-change/diff helpers.
- `generatedJsonResult.ts` and `JsonSummaryView.tsx` provide structured-result recognition and compact
  JSON presentation; `../toolRenderers.tsx` contains shared output parsing.
- `userTextPartContent.ts` recognizes skill invocations and attachment links. Unknown slash text remains
  ordinary prose.
- `taskSessionIdParser.ts` parses text tags only. Those tags do not authorize native Thread navigation,
  child control or identity matching by title, order or timestamp.

## Native history and output

`lib/agent-runtime/thread-projection.ts` reconstructs the view from authoritative snapshots and the
original event cursor. Transient progress belongs to the current Run and stream sequence; a gap or
closed transport drops that projection and refreshes durable history. Closing a view stops observation,
not accepted execution.

`thread-content.ts` and `ThreadContent` project declared semantic parts. `ThreadMedia` reads bytes through
the exact original holder, part ordinal and execution identity. Ordinary output `data` stays opaque even
when it resembles an image descriptor. An incomplete output-body page is not a complete report.

## Verification

Use focused helper tests and the actual Thread consumer tests for the behavior being changed:

```sh
bun run --cwd packages/ui test src/components/chat/message/parts/toolSummary.test.ts
```

Choose broader checks when a change reaches shared contracts or bundling. Source inspection and helper
tests do not establish browser rendering performance or packaged-device behavior.
