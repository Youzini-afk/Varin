import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['*.test.ts'],
    // Platform-specific fixtures run only on their owner; portable shell and
    // updater contracts run through the same package entry on Linux/Windows.
    exclude: process.platform === 'linux' ? [] : ['linux-autostart.test.ts'],
    testTimeout: 30_000,
  },
});
