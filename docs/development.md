# Development Guide

See [architecture.md](architecture.md) for process boundaries and [README.md](README.md) for the documentation index. Code, schemas, tests, and `package.json` scripts are authoritative.

## Local Startup

Toolchain requirements: Node.js ([.nvmrc](../.nvmrc)), Bun ([package.json](../package.json)), Rust ([rust-toolchain.toml](../kernel/rust-toolchain.toml)), plus a C/C++ compiler and CMake for tree-sitter/Wasmtime.

```sh
bun install --frozen-lockfile
bun run dev
```

- `bun run dev` (`dev:web:hmr`): prepares shared runtime packages (reusing build cache), then starts Vite UI (`127.0.0.1:5180`) + Application Host API (`127.0.0.1:3902`).
- `bun run electron:dev`: builds/stages the native kernel and launches Electron with HMR UI (`electron:dev:bundled` uses bundled UI).
- Platform details: [packages/web/README.md](../packages/web/README.md) · [packages/electron/README.md](../packages/electron/README.md) · [packages/mobile/README.md](../packages/mobile/README.md).

### Reverse Proxy in Dev Mode

Configure `VARIN_HMR_HOST`, `VARIN_HMR_UI_PORT`, `VARIN_HMR_API_PORT`, and Vite's `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS` when using custom domains. Point your reverse proxy at the UI port with WebSockets enabled, preserving `Host`, `Origin`, `X-Forwarded-Host`, and `X-Forwarded-Proto`:

```nginx
proxy_set_header Host $http_host;
proxy_set_header X-Forwarded-Host $http_host;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
```

## Commands

| Purpose | Root command |
| --- | --- |
| Build shared runtime outputs & Host types | `bun run build:type-dependencies` |
| Full cross-package type-check / prepared only | `bun run type-check` / `bun run type-check:prepared` |
| Lint | `bun run lint` |
| Source package tests / built dist tests | `bun run test:packages` / `bun run test:packages:dist` |
| Platform-specific non-native package tests | `bun run test:packages:platform` |
| Rust check / release kernel build | `bun run kernel:check` / `bun run kernel:build` |
| Rust workspace tests | `bun run test:rust` |
| Regenerate / verify Rust ↔ TS protocol | `bun run kernel:protocol` / `node scripts/generate-kernel-protocol.mjs --check` |
| Native Host + kernel tests (uses staged release binary; pass `--build` to rebuild) | `bun run test:kernel` / `bun run test:kernel -- --platform` |
| Host file/credential/lock/process tests | `bun run --cwd packages/web test:platform` |
| Tooling, build & release script tests | `bun run test:tooling` |
| Build frontend / Electron desktop package | `bun run build:frontend` / `bun run electron:build` |
| Validate user + engineering doc links | `bun run docs:validate` (`test:docs` tests the validator) |

Targeted test examples:
- Single TS test (Node test runner): `node --import tsx --test packages/<pkg>/test/<file>.test.ts`
- Single Vitest file in `web` or `ui`: `bun run --cwd packages/web test <path>`
- Single native kernel test: `bun run test:kernel -- --vitest-file=application-host/lib/<file>.native.test.ts` (add `--vitest-test-name=<pattern>` to narrow)
- Single Rust unit test: `cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib <filter> --locked` (append `-- --ignored` for explicit ignored tests)

## Verification

Pick tests that verify the real owner of the behavior you changed — do not duplicate the same assertion in every consumer or mock away the owner being tested:

| Owner / Layer | Primary Verification |
| --- | --- |
| Rust state machines, storage, upgrades, revocation | `bun run test:rust` (real SQLite/Storage; TS mocks cannot prove Rust durability/GC) |
| Host admission, orchestration & HTTP routes | `bun run test:packages` (doubles supply peer outputs only) |
| Host ↔ Rust IPC, real processes, file leases, multi-Host | `bun run test:kernel` (`*.native.test.ts` on Linux & Windows) |
| Client protocol, auth & observation bus | `packages/application-client` tests |
| Shells, Document Registry & UI projections | `packages/ui`, `extension-surface`, `electron` behavioral tests |
| Built artifacts, cloud layout & installers | `test:packages:dist`, `test:node-smoke`, cloud smoke, installer smoke |

- **CI scoping**: [scripts/ci-scope.mjs](../scripts/ci-scope.mjs) selects PR checks by changed owner; full job graph lives in [ci.yml](../.github/workflows/ci.yml) (containers: [container-check.yml](../.github/workflows/container-check.yml), [docker.yml](../.github/workflows/docker.yml), [docker-commit.yml](../.github/workflows/docker-commit.yml)).
- **Real-device & multi-Host evidence**: See [runtime-acceptance.md](runtime-acceptance.md). Key native multi-Host suites: [managed-transport.native.test.ts](../packages/web/application-host/lib/external-agents/managed-transport.native.test.ts) and [managed-project-management.native.test.ts](../packages/web/application-host/lib/projects/managed-project-management.native.test.ts). Computer helper checks: [computer-driver/README.md](../packages/computer-driver/README.md) and [varin-computer-windows/README.md](../kernel/crates/varin-computer-windows/README.md).

## Build Outputs & Native Boundaries

- **Ordered builds**: [scripts/build-products.mjs](../scripts/build-products.mjs) stages content-hashed outputs and receipts in `artifacts/build`. Browser assets are independent of platform Host/kernel/CLI so mobile, desktop, and web/cloud consume only what they need without clobbering a running dev server.
- **Host types**: Checked in a dedicated Node TS project and consumed via `#application-host`; production builds exclude `*.test-helper.ts` / `*.fixture.ts`.
- **Protocol & binary gate**: After changing [kernel/protocol/schema.json](../kernel/protocol/schema.json), run `bun run kernel:protocol` and rebuild the kernel (`bun run kernel:build` or `bun run test:kernel -- --build`). Never hand-edit generated protocol files.
- **Lockfiles**: [bun.lock](../bun.lock) governs dev/workspace dependencies; [scripts/cloud-runtime.bun.lock](../scripts/cloud-runtime.bun.lock) governs staged cloud production deps (update with `bun run update:cloud-runtime-lock`). See [ops/dependency-updates.md](ops/dependency-updates.md).
