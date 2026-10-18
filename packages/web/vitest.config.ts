import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const uiSrc = fileURLToPath(new URL('../ui/src', import.meta.url));
const applicationHostSrc = fileURLToPath(new URL('./application-host', import.meta.url));

/**
 * Tests that drive the real release kernel (framed child process, durable
 * stores, OS process trees). They run exactly once, through
 * `scripts/test-kernel-authority.mjs` with `vitest.kernel.config.ts`, which
 * verifies a fresh manifest-matched binary before any of them execute. The
 * main suite excludes these acceptance files rather than skipping at runtime.
 * Some Documents fixtures use the kernel's native directory observer, so CI
 * still builds the kernel before running the package suite.
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

export const NATIVE_TEST_INCLUDE = ['**/*.native.test.ts'];

export default defineConfig({
  resolve: {
    alias: [
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
      ...NATIVE_TEST_INCLUDE,
    ],
  },
});
