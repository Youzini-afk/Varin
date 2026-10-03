# syntax=docker/dockerfile:1
ARG RUNTIME_BASE_IMAGE=ghcr.io/youzini-afk/varin-runtime-slim:main

FROM --platform=$BUILDPLATFORM rust:1.97.1-bookworm AS kernel-builder
WORKDIR /src
ARG BUILDARCH
ARG TARGETARCH
RUN apt-get update \
  && apt-get install -y --no-install-recommends cmake gcc-aarch64-linux-gnu g++-aarch64-linux-gnu \
  && rm -rf /var/lib/apt/lists/*
COPY package.json ./
COPY kernel ./kernel
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=private \
  --mount=type=cache,target=/src/kernel/target,sharing=private \
  set -eux; \
  case "$TARGETARCH" in \
    amd64) kernel_arch="x64"; kernel_target="x86_64-unknown-linux-gnu" ;; \
    arm64) \
      kernel_arch="arm64"; \
      kernel_target="aarch64-unknown-linux-gnu"; \
      export CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER="aarch64-linux-gnu-gcc"; \
      export CC_aarch64_unknown_linux_gnu="aarch64-linux-gnu-gcc"; \
      export CXX_aarch64_unknown_linux_gnu="aarch64-linux-gnu-g++"; \
      export AR_aarch64_unknown_linux_gnu="aarch64-linux-gnu-ar"; \
      ;; \
    *) echo "Unsupported Docker target architecture: $TARGETARCH" >&2; exit 1 ;; \
  esac; \
  if [ "$BUILDARCH" != "amd64" ]; then \
    echo "Varin's Linux cross-build stage requires an amd64 build runner, found $BUILDARCH" >&2; \
    exit 1; \
  fi; \
  build_identity="$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' package.json | head -n 1)"; \
  test -n "$build_identity"; \
  rustup target add "$kernel_target"; \
  VARIN_KERNEL_BUILD_IDENTITY="$build_identity" \
  VARIN_KERNEL_TARGET="$kernel_target" \
  VARIN_KERNEL_ARCH="$kernel_arch" \
  cargo build --manifest-path kernel/Cargo.toml --release --bin varin-kernel --locked --target "$kernel_target"; \
  install -D -m 0755 "kernel/target/$kernel_target/release/varin-kernel" /out/varin-kernel

FROM --platform=$BUILDPLATFORM oven/bun:1.3.14 AS builder
WORKDIR /app
ARG VARIN_SOURCE_REVISION
ARG TARGETARCH

# Keep dependency installation cacheable while still presenting every Bun
# workspace manifest required by the frozen monorepo lockfile.
COPY package.json bun.lock ./
COPY bun-patches ./bun-patches
COPY scripts/fix-deprecation.js ./scripts/fix-deprecation.js
COPY packages/application-client/package.json ./packages/application-client/package.json
COPY packages/electron/package.json ./packages/electron/package.json
COPY packages/extension-builtins/package.json ./packages/extension-builtins/package.json
COPY packages/extension-cli/package.json ./packages/extension-cli/package.json
COPY packages/extension-contract/package.json ./packages/extension-contract/package.json
COPY packages/extension-host/package.json ./packages/extension-host/package.json
COPY packages/extension-loader/package.json ./packages/extension-loader/package.json
COPY packages/extension-react/package.json ./packages/extension-react/package.json
COPY packages/extension-sdk/package.json ./packages/extension-sdk/package.json
COPY packages/extension-surface/package.json ./packages/extension-surface/package.json
COPY packages/mobile/package.json ./packages/mobile/package.json
COPY packages/pi-host/package.json ./packages/pi-host/package.json
COPY packages/pi-host/patches ./packages/pi-host/patches
COPY packages/protocol/package.json ./packages/protocol/package.json
COPY packages/runtime-broker/package.json ./packages/runtime-broker/package.json
COPY packages/runtime-client/package.json ./packages/runtime-client/package.json
COPY packages/settings-store/package.json ./packages/settings-store/package.json
COPY packages/ui/package.json ./packages/ui/package.json
COPY packages/web/package.json ./packages/web/package.json
RUN bun install --frozen-lockfile --ignore-scripts \
  && node ./scripts/fix-deprecation.js

COPY . .
COPY --from=kernel-builder /out/varin-kernel /tmp/varin-kernel
RUN VARIN_SOURCE_REVISION="${VARIN_SOURCE_REVISION}" \
  VARIN_KERNEL_PREBUILT=/tmp/varin-kernel \
  VARIN_TARGET_PLATFORM=linux \
  VARIN_TARGET_ARCH="${TARGETARCH}" \
  bun run build:cloud-runtime -- --output /app/artifacts/cloud-runtime --no-archive

# This stage runs on TARGETPLATFORM. Installing the canonical runtime tree here
# ensures native production dependencies match the image architecture instead
# of the builder architecture.
FROM ${RUNTIME_BASE_IMAGE} AS runtime
WORKDIR /home/varin/app

ENV HOME=/home/varin \
  NODE_ENV=production \
  VARIN_DATA_DIR=/home/varin/.config/varin \
  VARIN_WORKSPACE_ROOT=/home/varin/workspaces

COPY --from=builder --chown=varin:varin /app/artifacts/cloud-runtime/ ./
RUN --mount=type=cache,target=/home/varin/.cache/bun,uid=1000,gid=1000 \
  bun install --production --frozen-lockfile --cache-dir=/home/varin/.cache/bun \
  && node --input-type=module -e "import { createRequire } from 'node:module'; import { existsSync } from 'node:fs'; import path from 'node:path'; const broker = await import('./packages/web/node_modules/@varin/runtime-broker/dist/index.js'); if (typeof broker.resolveBundledPiHostEntry !== 'function') throw new Error('Varin runtime broker is missing resolveBundledPiHostEntry'); const entry = broker.resolveBundledPiHostEntry(); if (typeof entry !== 'string' || entry.length === 0) throw new Error('Varin host entry did not resolve'); const webRequire = createRequire(new URL('./packages/web/package.json', import.meta.url)); webRequire.resolve('sherpa-onnx-node'); const pdfMain = webRequire.resolve('pdfjs-dist/legacy/build/pdf.mjs'); const pdfRequire = createRequire(pdfMain); const canvas = pdfRequire('@napi-rs/canvas'); const surface = canvas.createCanvas(2, 2); const context = surface.getContext('2d'); context.fillStyle = '#ff0000'; context.fillRect(0, 0, 1, 1); if (context.getImageData(0, 0, 1, 1).data[0] !== 255) throw new Error('PDF Canvas native runtime did not draw'); const pdfRoot = path.dirname(webRequire.resolve('pdfjs-dist/package.json')); for (const asset of ['legacy/build/pdf.worker.mjs', 'cmaps/Adobe-GB1-0.bcmap', 'standard_fonts/FoxitDingbats.pfb']) if (!existsSync(path.join(pdfRoot, asset))) throw new Error('PDF.js runtime asset is missing: ' + asset); console.log('Varin PDF.js assets and native Canvas runtime are available');" \
  && node verify-kernel.mjs packages/web

COPY --chmod=0755 scripts/docker-entrypoint.sh /usr/local/bin/varin-entrypoint

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=5 \
  CMD curl --fail --silent --show-error http://127.0.0.1:3000/health || exit 1

ENTRYPOINT ["/usr/local/bin/varin-entrypoint"]
CMD ["node", "packages/web/bin/cli.js", "serve", "--foreground"]
