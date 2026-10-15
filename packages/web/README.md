# @varin/web

Varin's browser, remote, and trusted server runtime.

This package serves the shared Varin UI and owns the trusted Application Host. Native Thread routes
use `@varin/application-client` and `@varin/protocol`; the packaged Rust `varin-kernel` contains the
Agent Catalog and execution runtime. The Host supplies models, credentials, extensions and domain
services without owning another conversation store or execution loop.

The Application Host, shared packages, UI and manifest-verified Rust kernel are one release unit.
Publishing only the browser bundle is not a supported deployment. The canonical cloud builder stages
`packages/web/kernel` and runs release smoke against the assembled runtime.

## Development

From the repository root:

```bash
bun install --frozen-lockfile
bun run dev:web:full
```

Or build and start the production-like server:

```bash
node scripts/build-cloud-runtime.mjs --install --no-archive
node artifacts/cloud-runtime/packages/web/bin/cli.js serve --foreground
```

The canonical cloud builder compiles the Application Host, shared packages and Web UI, stages the
Rust executable, and creates the production dependency layout and lockfile.

## Type and test boundaries

`bun run --cwd packages/web type-check` first validates the private protocol, prepares/checks the
Application Host and emits its declarations, then checks browser and CLI consumers. Host bodies use
their Node compiler settings; browser code retains its DOM settings. The existing `#application-host`
imports let cross-layer tests use those generated signatures without recompiling the Host as browser
code. Native Vitest resolves those same imports to the original Host source, so it does not substitute
declarations or a mock implementation at runtime. `*.native.test.ts` still runs only through the
[dedicated kernel acceptance entry](../../docs/development.md).

The root aggregate prepares the same shared outputs and Host declarations once, then uses
`type-check:prepared` for Web's remaining checks. That entry requires fresh dependencies and declarations.
Similarly, `build:raw` builds Host, kernel, CLI and browser artifacts from prepared shared packages;
use the self-contained `build` or `type-check` entries when working on this package directly.

The ordered extension-routing consumer check uses real settings controls, the original Web client,
the authenticated Express Router and extension-routing file CAS, without a listener or kernel process.
After preparing the shared dependencies, run it from the repository root:

```bash
node node_modules/vitest/vitest.mjs run --config packages/web/vitest.config.ts packages/web/src/api/extensions-routing-consumer.test.ts --maxWorkers=1
```

It covers reordering, missing members, Host/client reload, stale revision rejection, explicit empty
selection versus automatic routing, and the existing single-provider and workspace rules.

## Generated blocks in the HTML entry points

`index.html` and `mini-chat.html` paint the splash before any module is evaluated, so they cannot
import the modules that define it. They embed generated output instead, between `SPLASH-CSS`,
`SPLASH-MARK`, and `SPLASH-JS` sentinels. After changing anything in
`packages/ui/src/components/ui/varin-splash-*.ts`:

```bash
bun run splash:emit
```

Commit the generated HTML changes with the generator changes. Splash tests cover projection and
playback behavior; they do not freeze the generated CSS/HTML or the renderer's source text.

## Cloud and remote deployment

Use the Varin container images, Docker Compose, or the atomic SSH deployment helper. Image names,
persistent paths, environment variables, remote configuration, health validation, and rollback
behavior are documented in [Cloud deployment](../../docs/ops/cloud-deployment.md).

## Runtime data

Set `VARIN_DATA_DIR` to choose the persistent data root. The Linux default is
`~/.config/varin`. It contains settings, native Catalog/content data, authentication keys, remote
clients, pairing state, notifications, tunnel state, workspace identity, and document recovery
journals; it must remain outside immutable release directories.

Binding beyond loopback requires `VARIN_UI_PASSWORD`. Tunnel tokens and passwords are runtime-only
configuration and must not be placed in package archives or build arguments.

## License

[GNU Affero General Public License v3.0](LICENSE) (`AGPL-3.0-only`). Incorporated permissive
material retains the notices in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
