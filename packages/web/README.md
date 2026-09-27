# @varin/web

Varin's browser, remote, and trusted server runtime.

This package serves the shared Varin UI and owns the Web-side platform services. Conversation and
agent execution are provided by the bundled Pi runtime workspace:

```text
@varin/web
  -> @varin/runtime-broker
     -> @varin/pi-host
        -> @varin/protocol
```

The four packages and the manifest-verified Rust kernel are one release unit. Publishing or installing
only the browser bundle is not a supported deployment path because it would omit the private broker,
host, protocol, kernel executable, and their package exports. The canonical cloud builder stages
`packages/web/kernel` and runs its release smoke before accepting the runtime.

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

The canonical cloud builder compiles the Pi host/broker and Web UI, creates a production lockfile,
and preserves the workspace layout required by `resolveBundledPiHostEntry()`.

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
`~/.config/varin`. It contains settings, runtime registry files, authentication keys, remote
clients, pairing state, notifications, tunnel state, workspace identity, and document recovery
journals; it must remain outside immutable release directories.

Binding beyond loopback requires `VARIN_UI_PASSWORD`. Tunnel tokens and passwords are runtime-only
configuration and must not be placed in package archives or build arguments.

## License

[GNU Affero General Public License v3.0](LICENSE) (`AGPL-3.0-only`). Incorporated permissive
material retains the notices in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
