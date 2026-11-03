import { resolveNodeRuntime } from '@varin/protocol/node/runtime';
import path from 'node:path';
import { createWorkspaceTaskRunner } from './tasks.js';
import { createDebugSupervisor } from './debug-supervisor.js';
import { createTestSupervisor } from './test-supervisor.js';
import { VARIN_NODE_DAP_ADAPTER_ARGS } from './servers.js';
import type { RunRuntimeOptions } from './types.js';

export const createRunRuntime = ({
  documents,
  spawn,
  pathModule = path,
  env = process.env,
  isTrusted = async () => false,
  execPath = resolveNodeRuntime({ env }).executable,
  registerBuiltins = true,
}: RunRuntimeOptions) => {
  const tasks = createWorkspaceTaskRunner({
    documents,
    spawn,
    pathModule,
    env,
    isTrusted,
    execPath,
  });
  const debug = createDebugSupervisor({
    documents,
    spawn,
    pathModule,
    env,
    isTrusted,
  });
  const tests = createTestSupervisor({
    documents,
    spawn,
    pathModule,
    env,
    isTrusted,
    execPath,
  });
  if (registerBuiltins) {
    debug.registerAdapter({
      adapterId: 'varin.node',
      command: execPath,
      args: VARIN_NODE_DAP_ADAPTER_ARGS,
      languageIds: ['javascript', 'javascriptreact', 'typescript'],
      source: 'builtin',
    });
    tests.registerProvider({
      providerId: 'varin.node-test',
      kind: 'node-test',
      source: 'builtin',
    });
  }
  return {
    tasks,
    debug,
    tests,
    async dispose() {
      await Promise.all([
        tasks.dispose(),
        debug.dispose(),
        tests.dispose(),
      ]);
    },
  };
};
