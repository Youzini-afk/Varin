# Varin extension examples

Working extensions that use the same contracts as the built-in ones. Each folder is an ordinary
package: build it with `@varin/extension-cli`, install it through **Settings → Varin Extensions**,
and review the capability grants it requests. None of them import `@varin/ui` or any Varin product
React module. The [extension authoring guide](../../docs/ops/varin-extension-authoring.md) explains
the contracts they use.

## Agent policies

`varin.agent.policy@4` extensions that decide what a Run does next. Core owns every action,
permission, wait, result and history item; a policy owns only its versioned private state.

- [Bounded evidence policy](evidence-policy/README.md): gathers committed file evidence before the
  first model request and chooses the next read from it.
- [Bounded planning policy](planning-policy/README.md): requests one tool-free planning model job,
  reads its committed plan, then chooses an evidence graph for the main model's answer.
- [Plan, question and process policy](domain-policy/README.md): reads and updates a plan, asks the
  user, and observes a PTY process, without provider inference.
- [Fixed-source collaboration policy](collaboration-policy/README.md): dispatches a read-only child,
  reads independently, then waits for the child's report.
- [Delivery and explicit pause policy](delivery-pause-policy/README.md): delivers, pauses, resumes
  the Run explicitly and completes.

## Agent tools

Tools declared once in the manifest; discovery, model metadata, validation and inspection read the
same declaration.

- [Stored material snapshot reader](material-snapshot-tool/README.md): bounded reads through the
  original material owner.
- [Fixed child result integration](child-integration-tool/README.md): applies a published child
  result through the original integration journal.
- [Research experiment tools](research-tools/README.md): submit, wait for and read independent
  experiments in the research domain.
- [Project calendar tool](scheduled-task-tool/README.md): `scheduled_task` through the
  `tasks.schedules` Host capability.
- [Memory then read](nested-tools/README.md): calls the native `memory` tool, then optionally
  `file_read`, from inside one tool.
- [Gmail](gmail/README.md): connect a Google account locally and search, read, or send plain-text mail.
- [Agent-authored text counter](agent-authored-panel/README.md): fixed input for the
  `extension_package` tool, with a Host entry and a self-contained panel.

## Context, model and observation services

- [Independent source compaction](context-compaction/README.md): a `varin.context.compaction@1`
  provider that plans summaries over the core's quoted source; Core executes and commits the plan.
- [Context budget decision](context-budget/README.md): a `varin.context.budget@1` decision that
  chooses when and which prefix to compact.
- [Project context contribution](project-context/README.md): adds project context fragments through
  `provideContextFragments`.
- [Custom text/SSE model protocol](model-protocol/README.md): contributes a channel, model
  candidates and its own wire codec; HTTP, credentials, cancellation and usage stay with Varin.
- [Committed Run activity projection](run-activity/README.md): consumes `varin.run.activity@1` and
  keeps a queryable per-Run activity projection from committed metadata only.

## Start a new extension

The CLI generates workbench, editor, view and language starters outside this repository:

```sh
npx @varin/extension-cli init ./vanilla-shell --id dev.example.vanilla-shell --name "Vanilla Shell" --template shell
npx @varin/extension-cli init ./custom-editor --id dev.example.custom-editor --name "Custom Editor" --template editor
npx @varin/extension-cli init ./sidebar-view --id dev.example.sidebar-view --name "Sidebar View" --template view
npx @varin/extension-cli init ./language-provider --id dev.example.markdown-language --name "Markdown Language" --template language
```

After the `@varin/*` packages are published or installed from this workspace, each project can run
`npx varin-extension build` and `npx varin-extension test`. Isolated document edits use the granted
`workspace.documents` capability; disabling destroys the isolated realm and leaves Core document and
layout state in place.

Language and debug projects include their starter protocol process in `runtime/`. Their Host
entrypoint resolves that immutable package file with `context.assets.path`, never relative to the
user's workspace. The test template registers the built-in Node test provider. The custom-editor
template subscribes to Varin's shared document, updates the authoritative unsaved buffer with an
expected document version, and saves through the same controller; it does not create a second tab
or file-content store.

The coordinated public version for this workbench SDK is 0.2.0. Do not npm tag or publish until that
release is explicitly approved.
