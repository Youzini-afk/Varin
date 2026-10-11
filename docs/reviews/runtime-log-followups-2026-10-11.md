# Original research log conditions and durable continuation

Date: 2026-10-11. Baseline: `851c93cb715a23553bda5b6184201c77f64b54ed`.

This slice implements research stdout/stderr literal and end conditions through the existing
follow-up owner. It continues the two runtime designs and the maintainer's
[integration acceptance](runtime-2026-10-11.md); it does not establish complete design or product acceptance.

## Behavior and ownership

The ordinary `follow_up` tool version **7**, authenticated User route, application-client and shared
Follow-ups UI consume the same original source declarations. `jobs` / `jobSources` declares actual
supported observations for an accepted Job; no additional tool-name or domain allowlist is introduced.
Both actual ModelStep and PolicyAction invocations retain their original caller/source authority.

A `log_literal` leaf selects stdout or stderr, a nonempty UTF-8 literal and optional byte `fromOffset`.
The default is zero, including retained published history. Matching is case-sensitive and byte-exact,
not regex, line matching or decoded display text. Explicit `each` includes overlapping matches.
Invalid UTF-8 output remains valid bytes; it is not silently replaced before matching. A future offset
is retained even when the stream ends earlier. `log_end` is a separate finite fact, including empty
streams. It requires original executor/output drainage; neither an empty current page nor artifact
collection alone establishes EOF.

ExperimentService and its original Storage records/objects own logs. The original Job byte high-water
CAS publishes chunks; a durable chunk ahead of that CAS remains unobserved. The new partial Storage
index pages those same records by attempt, stream and byte range under original record grants.
The body uses the existing immutable object reader. There is no copied log store, observer Job or
replacement experiment. Storage **13 → 14** and Catalog **40 → 41** directly reject older internal
formats; no user asset migration or compatibility backend is added.

A transient, cooperatively yielding Host matcher reads the original registration intent on demand.
Catalog retains only the exact short binding, byte offset, matched prefix, ended/error state and
original accepted source/occurrence facts. Each cursor advance and at most one match commit together;
restart between overlapping hits resumes from that exact position. Original command-intent roots
retain the literal through GC; list/control do not hydrate it. Compiled patterns leave the cache when
their work ends, fails or is rejected, using the original observer scan rather than a new timer.

The existing family reader, accepted HostJobBinding, source selection, owner epoch, control generation
and expected cursor fence admission/publication. Pause holds observation; Resume retries the same
cursor and clears its explicit diagnostic. Cancelling a definition or its optional Wait does not stop
the target Job. Body reads remain separate from research cancellation/terminal reconciliation. Original
notifications arriving during reads or scan cleanup remain pending.

## Exhaustion, input and recovery

No-match EOF does not create a false occurrence or input. Catalog derives `exhausted` from its original
source queues. Any remains eligible while another leaf can emit; All may consume queued matches from
an ended leaf. Once no further combination is possible, unrelated research observation, file watches
and clock deadlines stop, retaining accepted occurrences for original delivery. No second persisted
terminal ledger was added.

An explicit observation Wait completes once with `exhausted` when no occurrence can trigger it.
A committed earlier match wins even when EOF arrives before generic Wait reconciliation. The original
occurrence, Wait, input, history, Goal/pause/source checks and root/child execution owner continue to
own delivery. The UI consumes the owner projection, retains pending work and uses the original key,
Run and complete trigger after an uncertain response. Short evidence fixes the accepted byte range;
detail reads restore the literal independently of later log growth.

Independent review reproduced a distinct cross-consumer failure through the original Catalog API:
a legal Run failure settled its handed-off observation without writing new history, then no-match
EOF exhausted the definition. The truthful `delivered: false` alone made the UI keep this ended card
active forever. The original Wait projection now derives `delivery_pending` from actual delivery and
the original Run terminal state. The UI distinguishes a pending result from one no longer applicable,
without manufacturing a delivery or adding another terminal record. The normal live Run path already
delivers the original Wait before consuming its follow-up input, so no speculative Once-ordering fix
was added.

A broad Host regression initially found duplicate backend release in the existing slow-collection
restart fixture. That fixture had left an unused default ExperimentService alive while constructing
another native service, creating two recovery owners. The correction only detaches that unused test
service. Production release did not gain a retry layer, silent duplicate guard or relaxed assertion.

## Public-entry integration check

Independent client → registered Host route probing found another real failure: the old HTTP helper
manually decoded only earlier trigger kinds. At reached the runtime, but literal, log-end and both
composites returned HTTP 400 before Rust. The fix removes that second nested semantic decoder rather
than adding two more names. HTTP still enforces authentication, exact outer fields and selected
Thread/branch/Run identity. It checks only the container shape needed by file-source traversal;
the original file helper retains path type, relative-path and actual source-grant checks. The original
Rust serde/registration validator owns leaf kinds, unknown fields and condition semantics. Private
caller-supplied authority, actor and Wait fields remain rejected at the User boundary.

The lead traced this slice's actual entry/consumer set:

- `ThreadFollowups` constructs explicit original data; Job choices consume owner `observationKinds`.
  `ThreadFollowupsAPI` and `threads-http.ts` send the same registration without another trigger filter.
- `thread-routes` → `thread-followups` checks authenticated identity/branch/Run;
  `AgentRuntimeClient` → `registerUserFollowup` adds authority only for real file leaves.
  `agent_followups` decodes the original registration on its request worker before Catalog admission.
- ModelStep and policy graph calls use `followup_tools` version 7 and the same Rust registration type.
  Input admission, launch assembly and child discovery consume `run_tools` owning declarations;
  there is no new grant/tool-name list. The generic policy SDK does not decode tool-specific triggers.
- Literal detail and short byte evidence have their existing public readers. The occurrence detail
  component's artifact/collection filter intentionally selects body-bearing metadata only; log byte
  ranges are already short evidence and are displayed by the regular occurrence view.
- Older Pi `followup.register` and its service are a separate existing runtime contract, not another
  Native entry. This slice does not silently redirect them or claim full Pi migration.

This finite mapping found no additional confirmed same-kind entry rejection. The public-client probe
and route regression run without sockets with a controlled RPC boundary; they are distinct from the
still-unexecuted complete native HTTP/IPC/process case.

## Verification

Independent review accepted this finite slice after both original failed probes passed following
the minimal corrections. Evidence remains separated by its actual boundary:

- The locked broad Rust run passed runtime **442 / 0 failed / 2 ignored** and kernel
  **144 / 0 failed / 11 ignored**. This run preceded the final derived Wait projection and
  HTTP-decoder corrections. After those changes, the complete owning follow-up file passed
  **58/58**, the actual child assembly Wait test passed both origins across its original four
  match/exhaustion paths and two terminal-Run paths, and all-targets checking passed.
- The actual Storage index test passed byte-range selection, 128-record pagination, actor denial
  and reopen. Host byte matcher, original ExperimentService and observer/client combination passed
  **53/53**; the final actual client/registered-route file passed **14/14** after decoder removal.
  Shared React consumer tests passed **59/59** after the final result-pending correction. These
  suites use controlled ports where stated; their totals are not added into an end-to-end claim.
- Independent original Catalog API probing reproduced then closed the terminal Wait/UI error,
  retaining truthful `delivered=false` and no fabricated history after reopen. A separate actual
  public client → registered route probe reproduced then closed all four log registration failures.
  Its final original Rust decoder check rejects eight invalid nested field/semantic cases intact;
  actor, Wait and private file authority injection remain rejected by the Host outer boundary.
- An independent real ExperimentService → durable-chunk/high-water → raw reader/matcher → original
  research-runtime subscription probe held the first body read while later bytes were published.
  The public research cancel reached the service/backend and original HostJob terminal reconciliation
  completed before releasing that reader, while collection was also held. It then matched a literal
  across both the 64 KiB and producer UTF-8 boundaries, observed empty stderr EOF separately, and
  reconstructed a new service/observer without respawn or replay. Catalog/Storage/backend ports were
  explicitly controlled; this is not native Storage/process or product IPC evidence.
- Final Host production and test types, protocol build/check, whole UI types, all 15 changed TS/TSX
  lint targets, documentation checks and actual Host bundle passed. The final bundle retained
  **540 reachable modules / 72 excluded legacy/test artifacts**.

The fresh Linux x64 debug kernel has identity `0.9.25` and target
`x86_64-unknown-linux-gnu`, SHA-256
`4c454d93c9cd6d831bb2cc94e43bf0cca1cd0f8f1f8e04cf093bd5d006f0d9f7`.
The existing real guardian/tree-stop/fixed-result regression passed **1/1** against this exact
executable. This is an actual local process/Storage check, distinct from the unrun complete Host path.
The final **5,225** tracked/unignored kernel/package/script inputs excluding Markdown were unchanged
through verification; the saved manifest SHA-256 is
`50a9b21bf0dea245fa40875524ad33255c86fae5d962456b379cd9a36baf659b`.

No paid model, installed browser workflow, remote execution, Windows/macOS run or performance result
is claimed here. Unix IPC remains unavailable in this cloud; the newly added real product case is
retained for a capable environment rather than counted as passed.

## Reproduce

Use the locked tools from [development](../development.md), at repository root:

```sh
cargo test --manifest-path kernel/Cargo.toml -p varin-runtime -p varin-kernel --locked -- --test-threads=2
cargo check --manifest-path kernel/Cargo.toml -p varin-runtime -p varin-kernel --all-targets --locked
(cd packages/web && bun x vitest run \
  application-host/lib/harness/experiments.test.ts \
  application-host/lib/harness/experiment-log-matcher.test.ts \
  application-host/lib/kernel/research-artifact-followups.test.ts \
  application-host/lib/kernel/research-log-followups.test.ts \
  application-host/lib/kernel/thread-followups.test.ts)
(cd packages/ui && bun x vitest run src/components/thread/ThreadConversation.behavior.test.tsx)
node scripts/generate-kernel-protocol.mjs --check
bun run --cwd packages/web build:application-host
```

In an environment supporting the actual kernel transport, run the existing `bun run test:kernel` lane,
including `process-wait-review.native.test.ts`. Its new original Research process/HTTP case writes a
split literal to stdout and an empty stderr, observes All, creates one new idle-root Run, then reopens
the same Storage and checks consumed input and no respawn. The case has not executed in this cloud
because Unix IPC listen is denied. It does not itself hold automatic collection; the held-collector
component case is the distinct evidence for EOF independence. Product transport was not changed.

## Remaining work

Metrics and the remaining domain/composition work continue separately: Computer/handoff/remote,
Web/material/PDF/scholarly/Bot, MCP resources/prompts/Tasks, durable scripts, and the remaining
SourceView/retrieval/context/provider integration. Generic preparation errors outside already closed
boundaries still need actionable owner projections. Full Host/browser/platform/real external-system
and performance acceptance remain separate. The maintainer's earlier Windows 78-pass result belongs
to its own baseline, not this new slice. Default runtime cutover, Pi removal and asset migration remain
with the user after acceptance.
