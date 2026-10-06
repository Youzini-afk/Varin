# @varin/extension-cli

`@varin/extension-cli` is the publishable author tool for Varin extensions. It works with the
public `varin.extension.json` contract and the framework-neutral `@varin/extension-sdk`; it does
not require the Varin monorepo or any Pi package.

## Commands

```sh
varin-extension init ./my-extension --id dev.example.my-extension --name "My Extension"
varin-extension init ./my-shell --id dev.example.shell --name "Vanilla Shell" --template shell
varin-extension check ./my-extension
varin-extension build ./my-extension
varin-extension test ./my-extension
```

Every command accepts `--quiet` for exactly one concise result or error line and `--json` for one
machine-readable JSON value. Quiet failures retain all validation issues in that single structured
line. Validation and non-zero failure exit codes are identical in human, non-TTY, quiet, and JSON
modes.

`init` is non-interactive. Both `--id` and `--name` are required, and an existing non-empty target is
never overwritten. `--template` selects `surface` (default), `shell`, `editor`, `view`, `language`, `debug`, or `test`.
The generated project contains a public manifest, package metadata, TypeScript configuration, and the
matching Surface or Host entrypoint. Language and debug templates also include a runnable packaged
protocol adapter under `runtime/`; the Host resolves it through `context.assets.path`, so it works from
local, npm, and immutable artifact installations. The test template uses Varin's native Node test
provider and does not generate a redundant adapter process.

The editor template computes a minimal offset edit and calls the public `applyEdits` controller method.
It handles stale, conflict, invalid-range, overlapping-ranges, and unsupported outcomes explicitly,
then saves through the same expected-document-version authority.

`check` parses the manifest with `@varin/extension-contract`, checks that the manifest version and
`package.json` version agree, and checks every declared Host or executable Surface file. Errors name
the failing path and the next useful action. The JSON output includes `incompatibleContributions`
(contributions with unknown contract versions — parsed but not executable on the current runtime),
`missingFiles`, and `referencedFiles`. A check with incompatible contributions still succeeds (exit 0)
because the manifest is structurally valid.

`build` bundles each declared executable entrypoint with esbuild. Host entrypoints use the Node 22
platform; Surface entrypoints use the browser platform. The manifest `file` remains the exact output
path. The optional `package.json` `varin.build.entrypoints` map supplies a source path when the
manifest path is a published output path. Output format follows `.cjs`/`.mjs` and otherwise the
package `type`, so published JavaScript keeps its declared module semantics. No package lifecycle
script is run.

`test` checks and builds the project, then validates declarative, managed, native, and isolated
Surface lifecycle behavior. Managed/native modules run through `runSurfaceExtensionConformance`;
isolated modules run through `runIsolatedExtensionConformance`; brokered Host modules run through `runHostExtensionConformance`
with revisioned storage and no privileged capabilities. These public harnesses are also available
from `@varin/extension-sdk/testing` for an extension's own test suite.

The complete manifest, lifecycle, update, distribution-profile, and publishing workflow is in the
[Varin extension authoring guide](https://github.com/Youzini-afk/Varin/blob/main/docs/ops/varin-extension-authoring.md).
