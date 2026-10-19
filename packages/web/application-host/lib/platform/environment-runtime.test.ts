import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createPlatformEnvironmentRuntime } from './environment-runtime.js';

it.skipIf(process.platform !== 'win32')('reads Unicode environment values through the private Windows PowerShell UTF-8 probe', () => {
  const key = 'VARIN_TERMINAL_ENV_ENCODING_PROBE';
  const original = process.env[key];
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const runtime = createPlatformEnvironmentRuntime({ spawnSyncFn: ((_command, args, options) =>
    spawnSync(powershell, args ?? [], { ...options, env: { ...process.env, [key]: '中文路径🙂' } })) as typeof spawnSync });
  expect(runtime.getLoginShellEnvSnapshot()?.[key]).toBe('中文路径🙂');
  expect(process.env[key]).toBe(original);
});
