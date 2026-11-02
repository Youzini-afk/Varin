import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.kernel.config.js';
import { PLATFORM_NATIVE_INCLUDE } from './vitest.platform.config.js';

// The same verified binary, real resource fixtures and teardown assertions as
// the complete suite, selected by OS-sensitive owner rather than test outcome.
export default defineConfig({
  ...baseConfig,
  test: { ...baseConfig.test, include: PLATFORM_NATIVE_INCLUDE },
});
