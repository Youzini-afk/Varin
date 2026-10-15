# Context Budget Decision example

This installable brokered Host extension implements the bounded `varin.context.budget@1`
Decision service using `provideContextBudget`. It selects when and which legal prefix to compact,
and adds evidence-preserving instructions to the summary. It requests no capability grants,
has no runtime dependencies, and performs no model calls, filesystem access, network access or
tool calls during activation or decisions.

## Build and install

From the repository root, with its dependencies already installed and the current
`@varin/extension-contract` and `@varin/extension-sdk` built:

```sh
node examples/extensions/context-budget/build.mjs
node --test examples/extensions/context-budget/host.test.mjs
```

The build uses the repository's existing esbuild and produces a self-contained `host.cjs`.
It also regenerates `varin.extension.json` from the shared `VARIN_CONTEXT_BUDGET_SERVICE`
constant, including the complete method schemas. Do not hand-edit that generated contract.
The package and strategy version come from this directory's `package.json`.

Install this directory with the ordinary local package installation flow and enable it in
Extensions. In Settings' service routing, explicitly select **Evidence-preserving Context Budget**
for `varin.context.budget`, version 1, in the desired default, project or session scope. The provider
key is `example.context-budget:host:varin.context.budget@1`. Select one Decision provider.
Installing or enabling this package alone does not select it, even if it is the only installed
budget provider. Without an explicit selection, the core budget strategy remains in control.

## Explainable rule

The core calls `decide` before model dispatch with token estimates, current capacity/settings and
legal ancestor candidates. It supplies no conversation bodies, credentials, models or tools.

1. Continue when the input budget is zero. Otherwise, request blocking compaction only when the
   request estimate exceeds the current input budget.
2. Below that limit, request background preparation only when it is enabled and the estimate
   strictly exceeds `inputBudgetTokens * preparationWaterline`. Otherwise, continue.
3. Choose the supplied legal prefix whose retained-history estimate is closest to the current
   `keepRecentTokens`. Ties retain more history; equal retained estimates keep the first candidate.
   If there is no candidate, continue. The original candidate order and input are never modified.
4. Return that candidate's `throughId`, the mode, and instructions to preserve source references,
   measured outcomes, comparison baselines and explicit uncertainty.

All trigger and retention values come from existing context settings. This example adds no fixed
token threshold. `inputBudgetTokens` already accounts for the reserve; the rule does not subtract
it again. Media and provider-only counts indicate unmeasured costs, not invented token estimates.
Closeness to the retention target is a heuristic, not proof that the summarized request will fit.

This service controls a bounded decision, not the whole compaction algorithm. The core still owns
source legality, tool-pair boundaries, immutable ancestry, cancellation, the accepted summary recipe,
generation identity, checkpoint publication and subsequent capacity checks. The original tool-free
Core Run generates the actual summary. This package never receives the source text or produces
summary content. No old-contract readers or compatibility defaults are provided.

## Verification

The focused Node tests load the built entrypoint named by the real manifest, activate the actual
bundled SDK registration, compare that declaration with the shared service constant, and invoke
the registered handlers. They exercise the configured waterline, blocking behavior, closest legal
prefix, tie handling, missing candidates, metadata validation and cancellation. They do not start
the application server or call a model, and do not claim to verify summary quality or native
checkpoint publication.
