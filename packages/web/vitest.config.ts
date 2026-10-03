import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const uiSrc = fileURLToPath(new URL('../ui/src', import.meta.url));
const applicationHostSrc = fileURLToPath(new URL('./application-host', import.meta.url));

/**
 * Tests that drive the real release kernel (framed child process, durable
 * stores, OS process trees). They run exactly once, through
 * `scripts/test-kernel-authority.mjs` with `vitest.kernel.config.ts`, which
 * verifies a fresh manifest-matched binary before any of them execute. The
 * main suite must stay deterministic on a checkout with no Rust artifacts, so
 * these files are excluded here rather than skipped at runtime.
 */
export const COMMON_TEST_EXCLUDE = [
  '**/node_modules/**',
  '**/dist/**',
  '**/dist-ssr/**',
  '**/.application-host-dev-*/**',
  // Node smoke tests use node:test, not vitest — run with `node --test` instead.
  '**/*.smoke.test.ts',
  // Run the real framed child-process suite with Node through test:kernel.
  '**/lib/kernel/kernel-client.test.ts',
];

export const KERNEL_VITEST_FILES = [
  'application-host/lib/bots/bot-delete.acceptance.test.ts',
  'application-host/lib/computer/computer-evidence.acceptance.test.ts',
  'application-host/lib/kernel/file-resource-audit.test.ts',
  'application-host/lib/kernel/kernel-compute.test.ts',
  'application-host/lib/kernel/kernel-process.test.ts',
  'application-host/lib/kernel/kernel-transport.acceptance.test.ts',
  'application-host/lib/kernel/process-consumers.test.ts',
  'application-host/lib/kernel/shell-supervisor-process-tree.test.ts',
  'application-host/lib/kernel/storage-adapter.test.ts',
  'application-host/lib/recovery/kernel-durable-engine.test.ts',
  'application-host/lib/harness/shell-assembly.test.ts',
  'application-host/lib/harness/followups.test.ts',
  'application-host/lib/harness/sources.test.ts',
  'application-host/lib/harness/resources.test.ts',
  'application-host/lib/harness/experiments.test.ts',
  'application-host/lib/harness/experiment-workspace.test.ts',
  'application-host/lib/harness/workspace-identity.test.ts',
  'application-host/lib/lsp/bundled-language.test.ts',
  'application-host/lib/knowledge/catalog-scan.test.ts',
  'application-host/lib/harness/explore-service.test.ts',
  'application-host/lib/documents/authority-surface-identity.test.ts',
  'application-host/lib/harness/document-read-source.test.ts',
  'application-host/lib/harness/thread-lifecycle.acceptance.test.ts',
  'application-host/lib/harness/working-state/materialized-baseline-update.acceptance.test.ts',
  'application-host/lib/terminal/shell-integration.live.test.ts',
  'test/integration-surface-vertical.test.ts',
];

export default defineConfig({
  resolve: {
    alias: [
      { find: 'bun:test', replacement: fileURLToPath(new URL('./test/bun-test-shim.ts', import.meta.url)) },
      // CLI sources address the Application Host through a private package import so the
      // published bin/ output resolves server/. Tests run against Host source instead,
      // which keeps them working in a clean checkout with nothing generated yet.
      { find: '#application-host', replacement: applicationHostSrc },
      { find: '@varin/ui', replacement: uiSrc },
      { find: '@', replacement: uiSrc },
    ],
  },
  test: {
    hookTimeout: 45_000,
    testTimeout: 45_000,
    exclude: [
      ...COMMON_TEST_EXCLUDE,
      ...KERNEL_VITEST_FILES,
    ],
  },
});
