import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config.js';

// These owners touch paths, files, credentials, locks or real subprocesses.
// Linux runs the complete portable suite. Normal platform checks use these
// owners; Windows qualification retains a full sweep for gaps between owners.
// New tests within these owners are discovered without a per-file list.
export const PLATFORM_TEST_INCLUDE = [
  'cli/**/*.test.ts',
  // Shared Host plumbing includes watcher canonicalization, shutdown and updates.
  'application-host/lib/*.test.ts',
  'application-host/lib/{client-auth,ui-auth,service-credentials,credentials,documents,fs,process,terminal,workspace,git,github,mcp,extensions,platform,knowledge,memory,lsp,computer,browser,external-agents,agent-resources,connections,tunnels,relay,kernel,storage,recovery,structure,language-support,projects}/**/*.test.ts',
];

export const PLATFORM_NATIVE_INCLUDE = [
  'application-host/lib/*.native.test.ts',
  'application-host/lib/{documents,storage,recovery,terminal,lsp,knowledge,external-agents,agent-resources,computer}/**/*.native.test.ts',
  'application-host/lib/kernel/{kernel-process,kernel-transport*,process-*,file-*,binary-file-*,storage-*,*source*,permission-*,*driver*}.native.test.ts',
];

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  resolve: baseConfig.resolve,
  test: { ...baseConfig.test, include: PLATFORM_TEST_INCLUDE },
});
