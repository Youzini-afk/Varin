# Independent Source Compaction example

An installable brokered Host Provider for `varin.context.compaction@1`. It produces the complete
algorithm plan over the core's immutable quoted source cut. It requests no capability grants and
makes no model, tool, filesystem or network calls. The native ContextJob owns execution and commits.

## Build and select

With repository dependencies and the current extension-contract and extension-sdk already built:

```sh
node examples/extensions/context-compaction/build.mjs
node --test examples/extensions/context-compaction/host.test.mjs
```

The existing esbuild workflow emits a self-contained `host.cjs` and regenerates the checked-in
`varin.extension.json` from `VARIN_CONTEXT_COMPACTION_SERVICE`. Install this directory through the
ordinary local extension flow. Explicitly select **Independent Source Compaction**, service version 1,
in Settings service routing for the intended project/session. The provider key is
`example.context-compaction:host:varin.context.compaction@1`. Installing alone does not opt in.
The separate `varin.context.budget` Decision still controls when/which legal prefix is compacted.

## Algorithm

1. A wholly textual cut of at most 512 UTF-8 bytes, including source labels, becomes direct extractive
   text. This preserves the quotation and requires zero model calls.
2. Otherwise, each source gets an independent leaf summary. Text larger than this example's explicit
   4096-byte chunk target is split on UTF-8 boundaries, further reduced using the supplied source
   budget. These ranges address the original unbudgeted quotation, not pre-partitioned fold material.
   Media remains whole; its cost is not guessed from base64 length.
3. Pairwise merge nodes combine independent outputs into a balanced tree. An odd subtree carries to
   the next level unchanged. Leaves do not include previous summaries, and merges reference exactly
   their child outputs. All nodes contribute to the final node.

The chunk calculation is a preparation heuristic, not a measured token guarantee. Native request and
publication checks remain authoritative. Original roles and identities stay in quoted text; this
Provider cannot promote a historical instruction to a current instruction. The native system safety
prompt also applies to every model node. The graph executes as normal, topologically ordered, serial
ModelSteps; this example makes no concurrency or quality claim.

`describe` and `prepare` use one actual service pin. Ordinary replacement preserves that preparation;
explicit revocation discards late unaccepted output. Once create accepts the frozen plan, the original
ContextJob owns it. Plugin unload does not cancel accepted work, and reopening does not call the
Provider again. Producer artifact/configuration/composition identity is separate from budget strategy.

Preparation receives only frozen quotations and `modelBudget`, plus this example's frozen algorithm
configuration. The source-cut hash locks those input facts. For `model_plan`, the original native
create/Launch independently fixes the actual full model configuration and credential scope. A direct
`text` candidate never asks the model credential/configuration routing owners to prepare a model,
including on first admission. Compaction Provider selection still uses its ordinary service route.

## Verification boundary

The focused example tests load the actual bundled entrypoint and SDK, compare its declaration with the
shared manifest contract, and exercise the nonlinear plan, Unicode ranges, media, direct text and
cancellation. Contract tests reject invalid references and stale cuts. Host owner tests use the real
SDK, routing resolver and service registry with controlled runtime preparation/storage ports; they
cover pin lifetime, replacement, revocation and failed selection. Those tests alone do not establish
installed broker behavior, native checkpoint publication, provider quality or parallel execution.

After building this example, the native interoperability test can run the actual Provider against
its real preview and admit the returned plan into the same original Catalog job:

```sh
VARIN_TEST_COMPACTION_BRIDGE="$PWD/examples/extensions/context-compaction/native-test-bridge.mjs" \
  cargo test --manifest-path kernel/Cargo.toml -p varin-runtime --test context_job_review \
  real_preview_quotes_prior_unicode_and_media_and_accepts_sdk_plan
```

The bridge only transfers test input/output files. Its preview includes a prior summary, Unicode
user evidence and media; the native test checks original ModelSteps and final publication. Model
responses remain a controlled fixture, not evidence of real-provider summary quality.
