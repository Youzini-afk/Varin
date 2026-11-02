import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config.js';

// These owners touch paths, files, credentials, locks or real subprocesses.
// Linux still runs the whole portable suite; qualification runs it on Windows
// too. New tests within these owners are discovered without a per-file list.
export const PLATFORM_TEST_INCLUDE = [
  'cli/**/*.test.ts',
  'application-host/lib/{client-auth,ui-auth,service-credentials,documents,fs,process,terminal,workspace,git,github,mcp,platform,knowledge,lsp,computer,external-agents,agent-resources,connections,tunnels,relay}/**/*.test.ts',
];

export const PLATFORM_NATIVE_INCLUDE = [
  'application-host/lib/{documents,storage,recovery,terminal,lsp,knowledge,external-agents,agent-resources,computer}/**/*.native.test.ts',
  'application-host/lib/kernel/{kernel-process,kernel-transport*,process-*,file-*,binary-file-*,storage-*,*source*,permission-*}.native.test.ts',
];

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  resolve: baseConfig.resolve,
  test: { ...baseConfig.test, include: PLATFORM_TEST_INCLUDE },
});
