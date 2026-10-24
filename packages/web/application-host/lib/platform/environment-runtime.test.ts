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

it('preserves an explicit Windows process PATH ahead of registry additions', () => {
  const runtime = createPlatformEnvironmentRuntime({ pathModule: path.win32 as typeof path,
    processLike: { platform: 'win32', env: { Path: 'D:\\CustomTools;C:\\Windows' } },
    spawnSyncFn: (() => ({ status: 0, stdout: 'Path=C:\\Windows;C:\\AddedTools\0', stderr: '', signal: null, pid: 1, output: [] })) as unknown as typeof spawnSync });
  expect(runtime.buildAugmentedPath()).toMatch(/^D:\\CustomTools;C:\\Windows;C:\\AddedTools(?:;|$)/);
});
