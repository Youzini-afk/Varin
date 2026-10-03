import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import baseConfig, { COMMON_TEST_EXCLUDE, NATIVE_TEST_INCLUDE } from './vitest.config.js';

/**
 * Native kernel authority suite — the only place these files run. Invoke via
 * `scripts/test-kernel-authority.mjs`, which verifies a manifest-matched
 * release binary and exports VARIN_TEST_KERNEL_PATH before this config runs.
 * Native filenames own discovery; a newly added file needs no manual allowlist.
 * Vitest `exclude` filters CLI file arguments too, so the kernel set needs its
 * own config instead of an exclusion plus an explicit list. The base `exclude`
 * names these same files, so `mergeConfig` (which concatenates array options)
 * cannot be used here.
 */
export default defineConfig({
  // The authority script invokes this config from the repository root; pin the
  // package root so the include list resolves independently of process.cwd().
  root: fileURLToPath(new URL('.', import.meta.url)),
  resolve: baseConfig.resolve,
  test: {
    ...baseConfig.test,
    include: NATIVE_TEST_INCLUDE,
    exclude: COMMON_TEST_EXCLUDE,
  },
});
