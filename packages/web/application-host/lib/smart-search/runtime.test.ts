import { describe, expect, it, vi } from 'vitest';
import { createSmartSearchRuntime } from './runtime.js';

const pathModule = await import('path');

type RuntimeDependencies = NonNullable<Parameters<typeof createSmartSearchRuntime>[0]>;
type Spawn = NonNullable<RuntimeDependencies['spawn']>;

interface SpawnResponse {
  code?: number;
  error?: Error;
  signal?: NodeJS.Signals | null;
  stderr?: string;
  stdout?: string;
}

type SpawnHandler = (effectiveArgs: readonly string[], bin: string, rawArgs: readonly string[]) => SpawnResponse;

const requireConfigValue = <Value>(values: Record<string, Value>, key: string): Value => {
  const value = values[key];
  if (!value) throw new Error(`Expected Smart Search config value: ${key}`);
  return value;
};

const createSpawn = (handlers: SpawnHandler): Spawn => vi.fn((bin: string, args: readonly string[]) => {
  const listeners: {
    close?: (code: number | null, signal: NodeJS.Signals | null) => void;
    error?: (error: Error) => void;
  } = {};
  const stdoutListeners: { data?: (chunk: Buffer) => void } = {};
  const stderrListeners: { data?: (chunk: Buffer) => void } = {};
  const child = {
    pid: 12345,
    stdout: { on: (_event: 'data', callback: (chunk: Buffer) => void) => { stdoutListeners.data = callback; } },
    stderr: { on: (_event: 'data', callback: (chunk: Buffer) => void) => { stderrListeners.data = callback; } },
    on: (event: 'close' | 'error', callback: ((error: Error) => void) | ((code: number | null, signal: NodeJS.Signals | null) => void)) => {
      if (event === 'error') listeners.error = callback as (error: Error) => void;
      else listeners.close = callback as (code: number | null, signal: NodeJS.Signals | null) => void;
    },
    kill: vi.fn(),
  };
  queueMicrotask(() => {
    const effectiveArgs = bin === 'cmd.exe' && args.slice(0, 3).join('\0') === ['/d', '/s', '/c'].join('\0')
      ? args.slice(4)
      : bin === process.execPath && /smart-search\.js$/.test(args[0] ?? '')
        ? args.slice(1)
      : args;
    const response = handlers(effectiveArgs, bin, args);
    if (response.error) {
      listeners.error?.(response.error);
      return;
    }
    if (response.stdout) stdoutListeners.data?.(Buffer.from(response.stdout));
    if (response.stderr) stderrListeners.data?.(Buffer.from(response.stderr));
    listeners.close?.(response.code ?? 0, response.signal ?? null);
  });
  return child;
}) as unknown as Spawn;

describe('Smart Search runtime', () => {
  it('sets protocol stdio without enabling global Python UTF-8 mode or replacing user choices', async () => {
    for (const env of [{}, { PYTHONIOENCODING: 'gbk', PYTHONUTF8: '0' }, { PYTHONIOENCODING: '', PYTHONUTF8: '' }]) {
      const spawn = createSpawn(() => ({ stdout: JSON.stringify({ ok: true }) }));
      const runtime = createSmartSearchRuntime({
        fsPromises: { readFile: vi.fn(), mkdir: vi.fn(), writeFile: vi.fn(), rename: vi.fn() },
        path: pathModule, spawn, env,
      });
      await runtime.runDoctor();
      const options = vi.mocked(spawn).mock.calls[0]![2]!;
      expect(options.env?.PYTHONIOENCODING).toBe('PYTHONIOENCODING' in env ? env.PYTHONIOENCODING : 'utf-8');
      expect(options.env?.PYTHONUTF8).toBe('PYTHONUTF8' in env ? env.PYTHONUTF8 : undefined);
    }
  });

  it('loads masked config without returning secret values', async () => {
    const configFile = pathModule.join('tmp', 'smart-search', 'config.json');
    const fsPromises = {
      readFile: vi.fn(async () => JSON.stringify({ XAI_API_KEY: 'sk-1234567890', XAI_MODEL: 'grok-4-fast' })),
      stat: vi.fn(async () => ({ mode: 0o600 })),
      mkdir: vi.fn(),
      writeFile: vi.fn(),
      rename: vi.fn(),
      chmod: vi.fn(),
      rm: vi.fn(),
    };
    const spawn = createSpawn((args) => {
      if (args[0] === 'config') return { stdout: JSON.stringify({ ok: true, config_file: configFile }) };
      return { stdout: 'smart-search 1.0.0' };
    });
    const runtime = createSmartSearchRuntime({ fsPromises, path: pathModule, spawn, env: {} });

    const config = await runtime.loadConfig();

    const apiKey = requireConfigValue(config.values, 'XAI_API_KEY');
    const model = requireConfigValue(config.values, 'XAI_MODEL');
    expect(apiKey).toMatchObject({ isSet: true, secret: true, source: 'config_file', editable: true });
    expect(apiKey.value).toBeUndefined();
    expect(apiKey.maskedValue).toBe('sk-1*****7890');
    expect(model.value).toBe('grok-4-fast');
  });

  it('uses explicit set/unset without disturbing omitted keys', async () => {
    const configFile = pathModule.join('tmp', 'smart-search', 'config.json');
    let file: Record<string, unknown> = { XAI_API_KEY: 'old-secret', XAI_MODEL: 'old-model', EXA_API_KEY: 'exa-secret' };
    const fsPromises = {
      readFile: vi.fn(async () => JSON.stringify(file)),
      stat: vi.fn(async () => ({ mode: 0o600 })),
      mkdir: vi.fn(),
      writeFile: vi.fn(async (_file: string, content: string) => { file = JSON.parse(content) as Record<string, unknown>; }),
      rename: vi.fn(),
      chmod: vi.fn(),
      rm: vi.fn(),
    };
    const spawn = createSpawn(() => ({ stdout: JSON.stringify({ ok: true, config_file: configFile }) }));
    const runtime = createSmartSearchRuntime({ fsPromises, path: pathModule, spawn, env: {} });

    await runtime.patchConfig({ set: { XAI_MODEL: 'new-model' }, unset: ['EXA_API_KEY'] });

    expect(file).toEqual({ XAI_API_KEY: 'old-secret', XAI_MODEL: 'new-model' });
  });

  it('returns doctor JSON even when CLI exits non-zero', async () => {
    const spawn = createSpawn((args) => {
      if (args[0] === 'doctor') return { code: 2, stdout: JSON.stringify({ ok: false, error_type: 'config_error' }) };
      return { stdout: JSON.stringify({ ok: true, config_file: '/tmp/config.json' }) };
    });
    const runtime = createSmartSearchRuntime({
      fsPromises: { readFile: vi.fn(), mkdir: vi.fn(), writeFile: vi.fn(), rename: vi.fn() },
      path: pathModule,
      spawn,
      env: {},
    });

    const doctor = await runtime.runDoctor();

    expect(doctor).toMatchObject({ ok: false, exitCode: 2, result: { ok: false, error_type: 'config_error' } });
  });

  it('redacts secrets from doctor JSON payloads', async () => {
    const spawn = createSpawn((args) => {
      if (args[0] === 'doctor') return { stdout: JSON.stringify({ ok: true, XAI_API_KEY: 'sk-1234567890' }) };
      return { stdout: JSON.stringify({ ok: true, config_file: '/tmp/config.json' }) };
    });
    const runtime = createSmartSearchRuntime({
      fsPromises: { readFile: vi.fn(), mkdir: vi.fn(), writeFile: vi.fn(), rename: vi.fn() },
      path: pathModule,
      spawn,
      env: {},
    });

    const doctor = await runtime.runDoctor();

    expect(doctor.result.XAI_API_KEY).toBe('sk-1*****7890');
  });

  it('rejects writes to environment-controlled keys', async () => {
    const configFile = pathModule.join('tmp', 'smart-search', 'config.json');
    const spawn = createSpawn(() => ({ stdout: JSON.stringify({ ok: true, config_file: configFile }) }));
    const runtime = createSmartSearchRuntime({
      fsPromises: { readFile: vi.fn(async () => '{}'), mkdir: vi.fn(), writeFile: vi.fn(), rename: vi.fn() },
      path: pathModule,
      spawn,
      env: { XAI_MODEL: 'env-model' },
    });

    await expect(runtime.patchConfig({ set: { XAI_MODEL: 'file-model' } })).rejects.toThrow(/controlled by environment/);
  });

  it('uses installed npm package wrapper before PATH command', async () => {
    const configFile = pathModule.join('tmp', 'smart-search', 'config.json');
    const packageRoot = pathModule.join('app', 'node_modules', '@konbakuyomu', 'smart-search');
    const packageWrapper = pathModule.join(packageRoot, 'npm', 'bin', 'smart-search.js');
    const spawn = createSpawn((args, bin) => {
      if (bin === process.execPath && args[0] === 'config') return { stdout: JSON.stringify({ ok: true, config_file: configFile }) };
      if (bin === process.execPath && args[0] === '--version') return { stdout: '0.1.12\n' };
      return { stdout: JSON.stringify({ ok: true, config_file: configFile }) };
    });
    const runtime = createSmartSearchRuntime({
      fsPromises: {
        access: vi.fn(async (file) => {
          if (String(file) === packageWrapper) return undefined;
          throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        }),
        readFile: vi.fn(async () => '{}'),
        mkdir: vi.fn(),
        writeFile: vi.fn(),
        rename: vi.fn(),
      },
      path: pathModule,
      spawn,
      env: {},
      resolvePackageRoot: () => packageRoot,
    });

    const status = await runtime.getStatus();

    expect(status.available).toBe(true);
    expect(status.binary).toBe('@konbakuyomu/smart-search package');
  });

  it('uses source checkout only when SMART_SEARCH_SOURCE_DIR is explicit', async () => {
    const sourceDir = pathModule.join('srv', 'smartsearch', 'src');
    const configFile = pathModule.join('tmp', 'smart-search', 'config.json');
    const spawn = createSpawn((args, bin) => {
      if (bin === 'cmd.exe') return { error: new Error('not found') };
      if (bin === 'python.exe' && args[0] === '-m' && args[2] === 'config') return { stdout: JSON.stringify({ ok: true, config_file: configFile }) };
      if (bin === 'python.exe' && args[0] === '-m' && args[2] === '--version') return { stdout: '0.1.12\n' };
      return { stdout: JSON.stringify({ ok: true, config_file: configFile }) };
    });
    const runtime = createSmartSearchRuntime({
      fsPromises: {
        access: vi.fn(async (file) => {
          if (String(file) === pathModule.join(sourceDir, 'smart_search', 'cli.py')) return undefined;
          throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        }),
        readFile: vi.fn(async () => '{}'),
        mkdir: vi.fn(),
        writeFile: vi.fn(),
        rename: vi.fn(),
      },
      path: pathModule,
      spawn,
      env: { SMART_SEARCH_SOURCE_DIR: sourceDir },
    });

    const status = await runtime.getStatus();

    expect(status.available).toBe(true);
    expect(status.binary).toContain(sourceDir);
  });
});
