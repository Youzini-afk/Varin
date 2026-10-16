import { describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createServer } from 'http';
import net from 'net';
import { spawn } from 'child_process';
import { pathToFileURL } from 'url';

import { isModuleCliExecution, normalizeCliEntryPath } from './cli-entry.js';
import { requestJson } from './lib/cli-http.js';
import { inspectTunnelAttachability } from './lib/cli-lifecycle.js';
import { formatGoal } from './lib/commands-schedule.js';
import { formatModelsOutput } from './lib/commands-models.js';
import { formatProjectLine } from './lib/commands-projects.js';
import { resolveTargetPort } from './lib/cli-api-target.js';
import { createServeCommand } from './lib/commands-serve.js';
import { createUpdateCommand } from './lib/commands-update.js';
import { terminateProcessTree } from './lib/cli-process.js';
import type { FetchLike, FetchResponseLike } from './lib/cli-http.js';
import type { CliOptions } from './lib/cli-types.js';
import {
  assertAuthenticatedNetworkExposure,
  commands,
  discoverVarinInstanceOnPort,
  discoverLifecycleInstances,
  discoverRunningInstances,
  discoverUnconfirmedRegistryInstanceOnPort,
  ensureTunnelProfilesMigrated,
  generateUiPassword,
  getInstanceFilePath,
  getPidFilePath,
  isVarinCmdline,
  isVarinProcessRunning,
  main,
  parseArgs,
  resolveServeHost,
  resolveServeUiPassword,
} from './cli.js';

async function withTempVarinDataDir<Result>(
  fn: (directory: string) => Promise<Result>,
): Promise<Result> {
  const previous = process.env.VARIN_DATA_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'varin-cli-test-'));
  process.env.VARIN_DATA_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (typeof previous === 'string') {
      process.env.VARIN_DATA_DIR = previous;
    } else {
      delete process.env.VARIN_DATA_DIR;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function createMockJsonResponse(body: unknown, ok = true): FetchResponseLike {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  };
}

async function captureStdout(fn: () => Promise<unknown> | unknown): Promise<string> {
  const originalWrite = process.stdout.write;
  let output = '';
  const captureWrite = (
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean => {
    output += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    if (typeof encodingOrCallback === 'function') encodingOrCallback();
    if (typeof callback === 'function') callback();
    return true;
  };
  Reflect.set(process.stdout, 'write', captureWrite);
  try {
    await fn();
    return output;
  } finally {
    process.stdout.write = originalWrite;
  }
}

async function startMockVarinServer(options: {
  pid?: number;
  runtime?: string;
} = {}) {
  const runtime = options.runtime || 'web';
  const pid = Number.isFinite(options.pid) ? options.pid : null;
  let shutdownRequested = false;
  let closed = false;
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/system/info') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ runtime, pid }));
      return;
    }

    if (req.method === 'POST' && req.url === '/api/system/shutdown') {
      shutdownRequested = true;
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify({ ok: true }));
      try {
        server.close(() => {
          closed = true;
        });
      } catch {
        closed = true;
      }
      return;
    }

    res.writeHead(404);
    res.end('not found');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    port,
    get shutdownRequested() {
      return shutdownRequested;
    },
    close: async () => {
      if (closed || !server.listening) return;
      await new Promise<void>((resolve) => {
        try {
          server.close(() => {
            closed = true;
            resolve();
          });
        } catch {
          closed = true;
          resolve();
        }
      });
    },
  };
}

async function allocateLoopbackPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function waitForTcpPort(port: number, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ port, host: '127.0.0.1' });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        socket.destroy();
        resolve(false);
      });
      socket.setTimeout(250, () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (connected) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

async function waitForTcpPortClosed(port: number, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await waitForTcpPort(port, 100))) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !(await waitForTcpPort(port, 100));
}

function spawnVarinLikeIdleProcess() {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'varin-idle'], { stdio: 'ignore' });
}

function spawnVarinLikeHungServer(port: number) {
  const script = `
    const net = require('net');
    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    server.listen(${port}, '127.0.0.1');
    setInterval(() => {}, 1000);
  `;
  const releaseEntry = path.join(
    os.tmpdir(),
    'varin',
    'releases',
    'test-release',
    'packages',
    'web',
    'server',
    'index.js',
  );
  return spawn(process.execPath, ['-e', script, releaseEntry], { stdio: 'ignore' });
}

const setFetchForTest = (implementation: FetchLike): void => {
  Reflect.set(globalThis, 'fetch', implementation);
};
const requestBodyText = (options?: RequestInit): string => (
  typeof options?.body === 'string' ? options.body : ''
);
const requestHeader = (options: RequestInit | undefined, name: string): string | null => (
  new Headers(options?.headers).get(name)
);

describe('cli server runtime', () => {
  async function withBunRuntime(fn: () => Promise<unknown>): Promise<void> {
    const bunDescriptor = Object.getOwnPropertyDescriptor(process.versions, 'bun');
    try {
      Object.defineProperty(process.versions, 'bun', { value: '1.3.14', configurable: true });
      await fn();
    } finally {
      if (bunDescriptor) Object.defineProperty(process.versions, 'bun', bunDescriptor);
      else Reflect.deleteProperty(process.versions, 'bun');
    }
  }

  it.each([
    ['serve'],
    ['serve', '--foreground'],
    ['startup', 'enable'],
  ])('rejects an explicit Bun invocation before running %j', async (...args) => {
    const argv = process.argv;
    try {
      process.argv = [process.execPath, 'varin', ...args];
      await withBunRuntime(async () => expect(main()).rejects.toMatchObject({
        message: 'Starting Varin requires Node.js. Run this command with node instead of bun.',
        exitCode: 2,
      }));
    } finally {
      process.argv = argv;
    }
  });

  it.each(['--help', '--version'])('keeps %s available under Bun', async (arg) => {
    const argv = process.argv;
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      process.argv = [process.execPath, 'varin', arg];
      await withBunRuntime(main);
      expect(output).toHaveBeenCalled();
    } finally {
      output.mockRestore();
      process.argv = argv;
    }
  });

  it('allows status under Bun but rejects a daemon restart before stopping the live server', async () => {
    await withTempVarinDataDir(async () => {
      const server = await startMockVarinServer();
      let stopped = false;
      try {
        await withBunRuntime(async () => {
          const options = { explicitPort: true, port: server.port, host: '127.0.0.1', json: true };
          const output = await captureStdout(() => commands.status(options));
          expect(JSON.parse(output).state).toBe('running');
          await expect(commands.restart.call({ stop: async () => { stopped = true; },
            serve: async () => server.port }, options)).rejects.toMatchObject({ exitCode: 2 });
        });
        expect(stopped).toBe(false);
        expect(server.shutdownRequested).toBe(false);
      } finally {
        await server.close();
      }
    });
  });

  it('rejects an update that would restart a daemon before shutdown or installation', async () => {
    await withTempVarinDataDir(async () => {
      const child = spawnVarinLikeIdleProcess();
      if (child.pid === undefined) throw new Error('Fixture process did not start');
      const server = await startMockVarinServer({ pid: child.pid });
      let installed = false;
      const update = createUpdateCommand({ packageManagerPath: 'fixture', serveCommand: async () => server.port,
        importFromFilePath: async () => ({ checkForUpdates: async () => ({ available: true, version: 'next' }),
          getCurrentVersion: () => 'current', detectPackageManager: () => 'fixture',
          executeUpdate: () => { installed = true; return { success: false, exitCode: 1 }; } }) });
      try {
        fs.writeFileSync(await getPidFilePath(server.port), String(child.pid));
        fs.writeFileSync(await getInstanceFilePath(server.port), JSON.stringify({ port: server.port, host: '127.0.0.1', launchMode: 'daemon' }));
        await withBunRuntime(async () => expect(update({ json: true })).rejects.toMatchObject({ exitCode: 2 }));
        expect(installed).toBe(false);
        expect(server.shutdownRequested).toBe(false);
      } finally {
        await terminateProcessTree(child.pid);
        await server.close();
      }
    });
  });

  it('starts the daemon with the current Node executable and keeps paths with spaces intact', async () => {
    await withTempVarinDataDir(async (directory) => {
      const serverPath = path.join(directory, 'server with spaces.mjs');
      fs.writeFileSync(serverPath, `
        import { start } from 'node:repl';
        import { createServer } from 'node:http';
        const server = createServer((_request, response) => {
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({ executable: process.execPath, node: process.versions.node,
            bun: Boolean(process.versions.bun), repl: typeof start }));
        });
        server.listen(0, '127.0.0.1', () => process.send({ type: 'varin:ready', port: server.address().port }));
        process.on('SIGTERM', () => server.close());
      `);
      const serve = createServeCommand({ serverPath,
        setForegroundServerActive() {}, setForegroundShutdown() {} });
      let pid: number | undefined;
      try {
        const port = await serve({ port: 0, host: '127.0.0.1', quiet: true,
          suppressQuietOutput: true, suppressUiPasswordWarning: true });
        if (typeof port !== 'number') throw new Error('Daemon did not return its ready port');
        pid = Number(fs.readFileSync(await getPidFilePath(port), 'utf8'));
        const response = await fetch(`http://127.0.0.1:${port}`);
        expect(await response.json()).toEqual({ executable: process.execPath,
          node: process.versions.node, bun: false, repl: 'function' });
        expect(JSON.parse(fs.readFileSync(await getInstanceFilePath(port), 'utf8'))).toMatchObject({
          port, host: '127.0.0.1', launchMode: 'daemon',
        });
      } finally {
        if (pid !== undefined) await terminateProcessTree(pid);
      }
    });
  });
});

describe('cli args', () => {

  it('accepts legacy daemon flags as no-ops', () => {
    expect(parseArgs(['serve', '--daemon']).removedFlagErrors).toEqual([]);
    expect(parseArgs(['serve', '-d']).removedFlagErrors).toEqual([]);
  });

  it('parses explicit connect-url server overrides', () => {
    const parsed = parseArgs(['connect-url', '--server', 'https://varin.example.com', '--port', '3002']);

    expect(parsed.command).toBe('connect-url');
    expect(parsed.options.server).toBe('https://varin.example.com');
    expect(parsed.options.port).toBe(3002);
  });

  it('parses connect-url server-url alias', () => {
    const parsed = parseArgs(['connect-url', '--server-url=http://homebridge:3002']);

    expect(parsed.options.server).toBe('http://homebridge:3002');
  });

  it('parses connect-url --relay flag', () => {
    const parsed = parseArgs(['connect-url', '--relay', '--name', 'My laptop']);

    expect(parsed.command).toBe('connect-url');
    expect(parsed.options.relay).toBe(true);
    expect(parsed.options.name).toBe('My laptop');
  });

  it('parses connect-url api-only help', () => {
    const parsed = parseArgs(['connect-url', '--api-only', '--help']);

    expect(parsed.command).toBe('connect-url');
    expect(parsed.options.apiOnly).toBe(true);
    expect(parsed.helpRequested).toBe(true);
  });

  it('parses startup api-only option', () => {
    const parsed = parseArgs(['startup', 'enable', '--api-only', '--port', '3002']);

    expect(parsed.command).toBe('startup');
    expect(parsed.startupAction).toBe('enable');
    expect(parsed.options.apiOnly).toBe(true);
    expect(parsed.options.port).toBe(3002);
  });

  it('parses schedule commands and options', () => {
    const parsed = parseArgs([
      'schedule',
      'create',
      '--project',
      'proj_1',
      '--name',
      'Daily review',
      '--prompt',
      'Review the repo',
      '--model',
      'openai/gpt-5.5',
      '--daily',
      '09:30',
      '--timezone',
      'Europe/Kyiv',
    ]);

    expect(parsed.command).toBe('schedule');
    expect(parsed.scheduleAction).toBe('create');
    expect(parsed.options.project).toBe('proj_1');
    expect(parsed.options.name).toBe('Daily review');
    expect(parsed.options.prompt).toBe('Review the repo');
    expect(parsed.options.model).toBe('openai/gpt-5.5');
    expect(parsed.options.daily).toBe('09:30');
    expect(parsed.options.timezone).toBe('Europe/Kyiv');
  });

  it('parses goal-enabled scheduled task options', () => {
    const parsed = parseArgs([
      'schedule',
      'create',
      '--dir',
      '/repo',
      '--name',
      'Finish migration',
      '--prompt',
      'Complete and verify the migration',
      '--model',
      'openai/gpt-5.5',
      '--daily',
      '09:30',
      '--goal',
      '--goal-token-budget',
      '200000',
    ]);

    expect(parsed.options.goal).toBe(true);
    expect(parsed.options.goalTokenBudget).toBe('200000');
  });

  it('formats scheduled goal state compactly', () => {
    expect(formatGoal({})).toBe('goal:no');
    expect(formatGoal({ goal: { budget: null } })).toBe('goal:yes');
    expect(formatGoal({ goal: { budget: { maxOutputTokens: 200000 } } })).toBe('goal:yes budget:200000');
  });

  it('parses models command', () => {
    const parsed = parseArgs(['models', '--json']);

    expect(parsed.command).toBe('models');
    expect(parsed.options.json).toBe(true);
  });

  it('parses projects command', () => {
    const parsed = parseArgs(['projects', '--json']);

    expect(parsed.command).toBe('projects');
    expect(parsed.options.json).toBe(true);
  });

  it('formats projects compactly', () => {
    expect(formatProjectLine({
      id: 'path_repo',
      label: 'Varin',
      path: '/repo/varin',
    })).toBe('- `Varin` — `path_repo` — `/repo/varin`');
  });

  it('formats the actual native model catalog', () => {
    expect(formatModelsOutput([{ providerId: 'openai', modelId: 'model', thinkingLevels: ['off', 'high'] }]))
      .toBe('Available models:\n- openai/model; thinking: off, high\n');
  });

  it('parses tunnel auto-start server options', () => {
    const parsed = parseArgs(['tunnel', 'start', '--port', '3002', '--api-only', '--lan', '--ui-password', 'secret']);

    expect(parsed.command).toBe('tunnel');
    expect(parsed.subcommand).toBe('start');
    expect(parsed.options.port).toBe(3002);
    expect(parsed.options.apiOnly).toBe(true);
    expect(parsed.options.host).toBe('0.0.0.0');
    expect(parsed.options.uiPassword).toBe('secret');
  });

  it('maps --lan to wildcard bind host', () => {
    const parsed = parseArgs(['serve', '--lan', '--port', '3002']);

    expect(parsed.options.host).toBe('0.0.0.0');
    expect(parsed.options.lan).toBe(true);
  });

  it('supports --hostname as top-level bind alias', () => {
    const parsed = parseArgs(['serve', '--hostname', '0.0.0.0']);

    expect(parsed.options.host).toBe('0.0.0.0');
  });

  it('keeps --hostname for tunnel commands', () => {
    const parsed = parseArgs(['tunnel', 'start', '--hostname', 'app.example.com']);

    expect(parsed.options.hostname).toBe('app.example.com');
    expect(parsed.options.host).toBeUndefined();
  });
});

describe('cli API target resolution', () => {
  it('uses an explicit port without discovery', async () => {
    await expect(resolveTargetPort(
      { explicitPort: true, port: 4567 },
      {
        discoverDesktopInstance: async () => { throw new Error('should not discover desktop'); },
        discoverLifecycleInstances: async () => { throw new Error('should not discover lifecycle'); },
      },
    )).resolves.toBe(4567);
  });

  it('prefers a desktop instance when no port is explicit', async () => {
    await expect(resolveTargetPort({}, {
      discoverDesktopInstance: async () => ({ port: 4500 }),
      discoverLifecycleInstances: async () => [{ port: 3001 }],
      isServerHealthReady: async () => false,
    })).resolves.toBe(4500);
  });

  it('uses the only discovered lifecycle instance', async () => {
    await expect(resolveTargetPort({}, {
      discoverDesktopInstance: async () => null,
      discoverLifecycleInstances: async () => [{ port: 3002 }],
      isServerHealthReady: async () => false,
    })).resolves.toBe(3002);
  });

  it('uses healthy default port when discovery finds no instances', async () => {
    await expect(resolveTargetPort({}, {
      discoverDesktopInstance: async () => null,
      discoverLifecycleInstances: async () => [],
      isServerHealthReady: async (port) => port === 3000,
    })).resolves.toBe(3000);
  });

  it('fails when multiple non-default instances are running', async () => {
    await expect(resolveTargetPort({}, {
      discoverDesktopInstance: async () => null,
      discoverLifecycleInstances: async () => [{ port: 3001 }, { port: 3002 }],
      isServerHealthReady: async () => false,
    })).rejects.toThrow('Multiple Varin instances are running');
  });
});

describe('network-exposed auth validation', () => {
  it('allows loopback without a UI password', () => {
    expect(() => assertAuthenticatedNetworkExposure({ host: '127.0.0.1' })).not.toThrow();
    expect(() => assertAuthenticatedNetworkExposure({ host: 'localhost' })).not.toThrow();
    expect(() => assertAuthenticatedNetworkExposure({ host: '::1' })).not.toThrow();
  });

  it('requires a UI password for LAN and wildcard bind hosts', () => {
    expect(() => assertAuthenticatedNetworkExposure({ host: '0.0.0.0' })).toThrow(/refuses to bind/);
    expect(() => assertAuthenticatedNetworkExposure({ host: '192.168.1.10' })).toThrow(/refuses to bind/);
  });

  it('allows network-exposed bind hosts with a UI password', () => {
    expect(() => assertAuthenticatedNetworkExposure({ host: '0.0.0.0', uiPassword: 'secret' })).not.toThrow();
  });

  it('allows explicit unsafe LAN override from process env only', () => {
    const previous = process.env.VARIN_ALLOW_UNAUTHENTICATED_LAN;
    process.env.VARIN_ALLOW_UNAUTHENTICATED_LAN = 'true';
    try {
      expect(() => assertAuthenticatedNetworkExposure({ host: '0.0.0.0' })).not.toThrow();
    } finally {
      if (typeof previous === 'string') {
        process.env.VARIN_ALLOW_UNAUTHENTICATED_LAN = previous;
      } else {
        delete process.env.VARIN_ALLOW_UNAUTHENTICATED_LAN;
      }
    }
  });
});

describe('serve UI password resolution', () => {
  it('keeps configured passwords and generates only for a bare explicit flag', () => {
    expect(resolveServeUiPassword({ uiPassword: 'secret', explicitUiPassword: true }))
      .toEqual({ password: 'secret', generated: false });
    const generated = resolveServeUiPassword({ uiPassword: '', explicitUiPassword: true });
    expect(generated.generated).toBe(true);
    expect(generated.password).toMatch(/^[A-HJ-NP-Za-km-z2-9]{16}$/);
    expect(resolveServeUiPassword({ uiPassword: undefined, explicitUiPassword: false }))
      .toEqual({ password: undefined, generated: false });
    expect(generateUiPassword()).not.toBe(generateUiPassword());
  });

  it('parses a bare --ui-password as explicit and empty', () => {
    const parsed = parseArgs(['serve', '--ui-password']);
    expect(parsed.options.explicitUiPassword).toBe(true);
    expect(parsed.options.uiPassword).toBe('');
  });
});

describe('serve host resolution', () => {
  it('uses VARIN_HOST when --host is not provided', () => {
    const previous = process.env.VARIN_HOST;
    process.env.VARIN_HOST = '192.0.2.20';
    try {
      expect(resolveServeHost(undefined)).toBe('192.0.2.20');
    } finally {
      if (typeof previous === 'string') {
        process.env.VARIN_HOST = previous;
      } else {
        delete process.env.VARIN_HOST;
      }
    }
  });

  it('prefers explicit --host over VARIN_HOST', () => {
    const previous = process.env.VARIN_HOST;
    process.env.VARIN_HOST = '192.0.2.20';
    try {
      expect(resolveServeHost('192.0.2.21')).toBe('192.0.2.21');
    } finally {
      if (typeof previous === 'string') {
        process.env.VARIN_HOST = previous;
      } else {
        delete process.env.VARIN_HOST;
      }
    }
  });
});

describe('CLI exports', () => {
  it('allows tunnel profile migration before command options are initialized', async () => {
    await withTempVarinDataDir(async () => {
      const store = ensureTunnelProfilesMigrated();

      expect(store).toEqual({ version: 1, profiles: [] });
    });
  });

  it('includes ngrok in fallback tunnel providers when no server is reachable', async () => {
    await withTempVarinDataDir(async () => {
      const port = await allocateLoopbackPort();
      const output = await captureStdout(async () => {
        await commands.tunnel({ json: true, explicitPort: true, port }, 'providers');
      });

      const body = JSON.parse(output) as { providers: Array<{ provider: string }>; source: string };
      expect(body.source).toBe('fallback');
      expect(body.providers.map((entry) => entry.provider)).toContain('ngrok');
    });
  });

  it('supports ngrok quick dry-run with an explicit port', async () => {
    await withTempVarinDataDir(async () => {
      const output = await captureStdout(async () => {
        await commands.tunnel({
          json: true,
          dryRun: true,
          explicitPort: true,
          port: 3003,
          provider: 'ngrok',
          mode: 'quick',
        }, 'start');
      });

      const body = JSON.parse(output);
      expect(body).toEqual(expect.objectContaining({
        ok: true,
        dryRun: true,
        provider: 'ngrok',
        mode: 'quick',
      }));
    });
  });
});

describe('CLI HTTP helpers', () => {
  it('retries UI-authenticated API requests with the stored instance password', async () => {
    await withTempVarinDataDir(async () => {
      const port = 45678;
      fs.writeFileSync(await getInstanceFilePath(port), JSON.stringify({ port, uiPassword: 'secret' }, null, 2));
      const originalFetch = globalThis.fetch;
      const calls: Array<{ options: RequestInit; url: string }> = [];
      setFetchForTest(async (url, options = {}) => {
        calls.push({ url: String(url), options });
        if (String(url).endsWith('/auth/session')) {
          expect(JSON.parse(requestBodyText(options))).toEqual({ password: 'secret' });
          return {
            ok: true,
            headers: { get: (name) => name.toLowerCase() === 'set-cookie' ? 'varin_ui_session=session-token; Path=/; HttpOnly' : null },
            json: async () => ({ authenticated: true }),
          };
        }
        if (requestHeader(options, 'Cookie') === 'varin_ui_session=session-token') {
          return createMockJsonResponse({ ok: true });
        }
        return {
          ok: false,
          status: 401,
          json: async () => ({ error: 'UI authentication required', locked: true }),
        };
      });

      try {
        const { response, body } = await requestJson(port, '/api/varin/tunnel/start', {
          method: 'POST',
          body: JSON.stringify({ provider: 'ngrok', mode: 'quick' }),
        });

        expect(response.ok).toBe(true);
        expect(body).toEqual({ ok: true });
        expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
          '/api/varin/tunnel/start',
          '/auth/session',
          '/api/varin/tunnel/start',
        ]);
      } finally {
        Reflect.set(globalThis, 'fetch', originalFetch);
      }
    });
  });

  it('prefers the stored instance password over a non-explicit env password', async () => {
    await withTempVarinDataDir(async () => {
      const port = 45679;
      fs.writeFileSync(await getInstanceFilePath(port), JSON.stringify({ port, uiPassword: 'stored-secret' }, null, 2));
      const originalFetch = globalThis.fetch;
      setFetchForTest(async (url, options = {}) => {
        if (String(url).endsWith('/auth/session')) {
          expect(JSON.parse(requestBodyText(options))).toEqual({ password: 'stored-secret' });
          return {
            ok: true,
            headers: { getSetCookie: () => ['varin_ui_session=session-token; Path=/; HttpOnly'] },
            json: async () => ({ authenticated: true }),
          };
        }
        if (requestHeader(options, 'Cookie') === 'varin_ui_session=session-token') {
          return createMockJsonResponse({ ok: true });
        }
        return {
          ok: false,
          status: 401,
          json: async () => ({ error: 'UI authentication required', locked: true }),
        };
      });

      try {
        const { response, body } = await requestJson(port, '/api/varin/scheduled-tasks/status', {
          uiPassword: 'stale-env-secret',
          explicitUiPassword: false,
        });

        expect(response.ok).toBe(true);
        expect(body).toEqual({ ok: true });
      } finally {
        Reflect.set(globalThis, 'fetch', originalFetch);
      }
    });
  });

  it('authenticates desktop-local API requests with the stored client token', async () => {
    await withTempVarinDataDir(async (dir) => {
      const port = 57123;
      fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
        desktopLocalPort: port,
        desktopLocalClientToken: 'varin_client_test',
      }, null, 2));
      const originalFetch = globalThis.fetch;
      setFetchForTest(async (_url, options = {}) => {
        if (requestHeader(options, 'Authorization') === 'Bearer varin_client_test') {
          return createMockJsonResponse({ ok: true });
        }
        return {
          ok: false,
          status: 401,
          json: async () => ({ error: 'Client authentication required', locked: true }),
        };
      });

      try {
        const { response, body } = await requestJson(port, '/api/varin/scheduled-tasks/status');

        expect(response.ok).toBe(true);
        expect(body).toEqual({ ok: true });
      } finally {
        Reflect.set(globalThis, 'fetch', originalFetch);
      }
    });
  });
});

describe('cli entry detection', () => {
  const modulePath = '/tmp/varin/bin/cli.js';
  const moduleUrl = pathToFileURL(modulePath).href;

  it('resolves symlinked entry paths before comparing', () => {
    const symlinkPath = '/usr/local/bin/varin';
    const realpath = (filePath: string): string => {
      if (filePath === path.resolve(symlinkPath)) {
        return modulePath;
      }
      return filePath;
    };

    expect(isModuleCliExecution(symlinkPath, moduleUrl, realpath)).toBe(true);
  });

  it('falls back to resolved paths when realpath fails', () => {
    const realpath = () => {
      throw new Error('realpath unavailable');
    };

    expect(isModuleCliExecution(modulePath, moduleUrl, realpath)).toBe(true);
  });

  it('returns false for non-matching entry path', () => {
    expect(isModuleCliExecution('/tmp/other-cli.js', moduleUrl)).toBe(false);
  });

  it('returns false for empty entry path', () => {
    expect(isModuleCliExecution('', moduleUrl)).toBe(false);
  });

  it('returns false when module url is not provided', () => {
    expect(isModuleCliExecution(modulePath)).toBe(false);
  });

  it('accepts wrapper binary name fallback when requested', () => {
    const wrapperPath = '/home/user/.local/bin/varin';
    expect(isModuleCliExecution(wrapperPath, moduleUrl, undefined, 'varin')).toBe(true);
  });

  it('normalizes direct paths when realpath fails', () => {
    const unresolvedPath = './packages/web/bin/cli.js';
    const realpath = () => {
      throw new Error('no symlink resolution');
    };

    expect(normalizeCliEntryPath(unresolvedPath, realpath)).toBe(path.resolve(unresolvedPath));
  });
});

describe('isVarinCmdline', () => {
  it('accepts Varin CLI and daemon cmdlines', () => {
    expect(isVarinCmdline('node /x/@varin/web/bin/cli.js serve')).toBe(true);
    expect(isVarinCmdline('node /x/@varin/web/server/index.js --port 9090')).toBe(true);
    expect(isVarinCmdline('bun /home/u/projects/Varin/packages/web/server/index.js --port 3001')).toBe(true);
    expect(isVarinCmdline('node /home/u/.local/share/varin/releases/r1/packages/web/server/index.js')).toBe(true);
    expect(isVarinCmdline('node C:\\Users\\u\\AppData\\Local\\Varin\\runtimes\\testing\\packages\\web\\bin\\cli.js')).toBe(true);
  });

  it('rejects recycled and unrelated processes (issue #1721)', () => {
    expect(isVarinCmdline('node /home/herjarsa/npm-global/bin/agentmemory')).toBe(false);
    expect(isVarinCmdline('node /usr/lib/node_modules/npm/bin/npm-cli.js install')).toBe(false);
    expect(isVarinCmdline('node /tmp/unrelated/packages/web/server/index.js')).toBe(false);
    expect(isVarinCmdline('')).toBe(false);
    expect(isVarinCmdline(null)).toBe(false);
  });
});

describe('isVarinProcessRunning', () => {
  it('returns false for a dead PID', () => {
    expect(isVarinProcessRunning(2147483646)).toBe(false);
  });

  // Identity verification is available on Linux (/proc) and macOS (ps); on those
  // platforms a live but unrelated process (a recycled stale PID) must read as
  // not-running so it can't trip the "already running" guard (issue #1721).
  it.skipIf(process.platform !== 'linux' && process.platform !== 'darwin')(
    'returns false for a live non-Varin PID',
    async () => {
      const child = spawn('sleep', ['30'], { stdio: 'ignore' });
      try {
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(isVarinProcessRunning(child.pid)).toBe(false);
      } finally {
        child.kill('SIGKILL');
      }
    }
  );
});

describe('lifecycle instance discovery', () => {
  it('does not attribute a desktop runtime response to a different explicit port', async () => {
    await withTempVarinDataDir(async (dir) => {
      fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ desktopLocalPort: 57123 }, null, 2));

      const instance = await discoverVarinInstanceOnPort(3003, {
        fetchImpl: async () => createMockJsonResponse({ runtime: 'desktop', pid: 934 }),
      });

      expect(instance).toBeNull();
    });
  });

  it('attributes a desktop runtime response to its configured desktop port', async () => {
    await withTempVarinDataDir(async (dir) => {
      fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ desktopLocalPort: 57123 }, null, 2));

      const instance = await discoverVarinInstanceOnPort(57123, {
        fetchImpl: async () => createMockJsonResponse({ runtime: 'desktop', pid: 934 }),
      });

      expect(instance).toEqual(expect.objectContaining({
        port: 57123,
        pid: 934,
        runtime: 'desktop',
      }));
    });
  });

  it('does not mark tunnel attachability as desktop for a different explicit port', async () => {
    await withTempVarinDataDir(async (dir) => {
      fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ desktopLocalPort: 57123 }, null, 2));
      const originalFetch = globalThis.fetch;
      setFetchForTest(async () => createMockJsonResponse({ runtime: 'desktop', pid: 934 }));
      try {
        const attachability = await inspectTunnelAttachability(3004, { requireHealthy: false });

        expect(attachability.reason).not.toBe('desktop');
      } finally {
        Reflect.set(globalThis, 'fetch', originalFetch);
      }
    });
  });

  it('keeps pid and instance files when live port probe confirms a cmdline mismatch', async () => {
    await withTempVarinDataDir(async () => {
      const port = 45123;
      const pid = 12345;
      const pidFile = await getPidFilePath(port);
      const instanceFile = await getInstanceFilePath(port);
      fs.writeFileSync(pidFile, String(pid));
      fs.writeFileSync(instanceFile, JSON.stringify({ port, launchMode: 'daemon', startedAt: 123 }, null, 2));

      const instances = await discoverRunningInstances({
        fetchImpl: async () => createMockJsonResponse({ runtime: 'web', pid }),
        getVarinProcessState: () => 'mismatched',
      });

      expect(instances).toEqual([
        expect.objectContaining({ port, pid, runtime: 'web', source: 'registry+probe' }),
      ]);
      expect(fs.existsSync(pidFile)).toBe(true);
      expect(fs.existsSync(instanceFile)).toBe(true);
    });
  });

  it('removes stale pid and instance files when a cmdline mismatch is not confirmed by live probe', async () => {
    await withTempVarinDataDir(async () => {
      const port = 45124;
      const pid = 12346;
      const pidFile = await getPidFilePath(port);
      const instanceFile = await getInstanceFilePath(port);
      fs.writeFileSync(pidFile, String(pid));
      fs.writeFileSync(instanceFile, JSON.stringify({ port, launchMode: 'daemon' }, null, 2));

      const instances = await discoverRunningInstances({
        fetchImpl: async () => createMockJsonResponse(null, false),
        getVarinProcessState: () => 'mismatched',
      });

      expect(instances).toEqual([]);
      expect(fs.existsSync(pidFile)).toBe(false);
      expect(fs.existsSync(instanceFile)).toBe(false);
    });
  });

  it('preserves matched pid and instance files when the recorded port probe is inconclusive', async () => {
    await withTempVarinDataDir(async () => {
      const port = 45126;
      const pid = 12347;
      const pidFile = await getPidFilePath(port);
      const instanceFile = await getInstanceFilePath(port);
      fs.writeFileSync(pidFile, String(pid));
      fs.writeFileSync(instanceFile, JSON.stringify({ port, launchMode: 'daemon' }, null, 2));

      const instances = await discoverRunningInstances({
        fetchImpl: async () => createMockJsonResponse(null, false),
        getVarinProcessState: () => 'matched',
      });

      expect(instances).toEqual([]);
      expect(fs.existsSync(pidFile)).toBe(true);
      expect(fs.existsSync(instanceFile)).toBe(true);
    });
  });

  it('preserves unknown-identity pid and instance files when the recorded port probe is inconclusive', async () => {
    await withTempVarinDataDir(async () => {
      const port = 45129;
      const pid = 12350;
      const pidFile = await getPidFilePath(port);
      const instanceFile = await getInstanceFilePath(port);
      fs.writeFileSync(pidFile, String(pid));
      fs.writeFileSync(instanceFile, JSON.stringify({ port, launchMode: 'daemon' }, null, 2));

      const instances = await discoverRunningInstances({
        fetchImpl: async () => createMockJsonResponse(null, false),
        getVarinProcessState: () => 'unknown',
      });

      expect(instances).toEqual([]);
      expect(fs.existsSync(pidFile)).toBe(true);
      expect(fs.existsSync(instanceFile)).toBe(true);
    });
  });

  it('uses the live system-info pid instead of a stale Varin-looking pid-file pid', async () => {
    await withTempVarinDataDir(async () => {
      const port = 45127;
      const stalePid = 12348;
      const livePid = 54321;
      const pidFile = await getPidFilePath(port);
      const instanceFile = await getInstanceFilePath(port);
      fs.writeFileSync(pidFile, String(stalePid));
      fs.writeFileSync(instanceFile, JSON.stringify({ port, launchMode: 'daemon' }, null, 2));

      const instances = await discoverRunningInstances({
        fetchImpl: async () => createMockJsonResponse({ runtime: 'web', pid: livePid }),
        getVarinProcessState: () => 'matched',
      });

      expect(instances).toEqual([
        expect.objectContaining({ port, pid: livePid, runtime: 'web', source: 'registry+probe' }),
      ]);
    });
  });

  it('uses the explicit host when probing a pid-file entry without a stored host', async () => {
    await withTempVarinDataDir(async () => {
      const port = 45128;
      const pid = 12349;
      const host = '192.0.2.10';
      const urls: string[] = [];
      fs.writeFileSync(await getPidFilePath(port), String(pid));
      fs.writeFileSync(await getInstanceFilePath(port), JSON.stringify({ port, launchMode: 'daemon' }, null, 2));

      const instances = await discoverLifecycleInstances(
        { explicitPort: true, port, host },
        {
          fetchImpl: async (url) => {
            urls.push(String(url));
            return createMockJsonResponse({ runtime: 'web', pid });
          },
          getVarinProcessState: () => 'matched',
        },
      );

      expect(instances).toEqual([
        expect.objectContaining({ port, pid, runtime: 'web', source: 'registry+probe' }),
      ]);
      expect(new URL(urls[0]!).hostname).toBe(host);
    });
  });

  it('tries loopback before treating an explicit-host pid-file probe as inconclusive', async () => {
    await withTempVarinDataDir(async () => {
      const port = 45130;
      const pid = 12351;
      const host = '192.0.2.11';
      const urls: string[] = [];
      fs.writeFileSync(await getPidFilePath(port), String(pid));
      fs.writeFileSync(await getInstanceFilePath(port), JSON.stringify({ port, launchMode: 'daemon' }, null, 2));

      const instances = await discoverLifecycleInstances(
        { explicitPort: true, port, host },
        {
          fetchImpl: async (url) => {
            urls.push(String(url));
            return new URL(String(url)).hostname === '127.0.0.1'
              ? createMockJsonResponse({ runtime: 'web', pid })
              : createMockJsonResponse(null, false);
          },
          getVarinProcessState: () => 'matched',
        },
      );

      expect(urls.map((url) => new URL(url).hostname)).toContain(host);
      expect(urls.map((url) => new URL(url).hostname)).toContain('127.0.0.1');
      expect(instances).toEqual([
        expect.objectContaining({ port, pid, runtime: 'web', source: 'registry+probe' }),
      ]);
    });
  });

  it('does not accept a fallback loopback probe with a different pid for a concrete host registry', async () => {
    await withTempVarinDataDir(async () => {
      const port = 45131;
      const pid = 12352;
      const otherPid = 54322;
      const host = '192.0.2.12';
      const pidFile = await getPidFilePath(port);
      const instanceFile = await getInstanceFilePath(port);
      fs.writeFileSync(pidFile, String(pid));
      fs.writeFileSync(instanceFile, JSON.stringify({ port, host, launchMode: 'daemon' }, null, 2));

      const instances = await discoverLifecycleInstances(
        { explicitPort: true, port, host },
        {
          fetchImpl: async (url) => {
            return new URL(String(url)).hostname === '127.0.0.1'
              ? createMockJsonResponse({ runtime: 'web', pid: otherPid })
              : createMockJsonResponse(null, false);
          },
          getVarinProcessState: () => 'matched',
        },
      );

      expect(instances).toEqual([]);
      expect(fs.existsSync(pidFile)).toBe(true);
      expect(fs.existsSync(instanceFile)).toBe(true);
    });
  });

  it('discovers an explicit live Varin port without a pid-file registry entry', async () => {
    await withTempVarinDataDir(async () => {
      const port = 45125;
      const instances = await discoverLifecycleInstances(
        { explicitPort: true, port },
        { fetchImpl: async () => createMockJsonResponse({ runtime: 'web', pid: null }) },
      );

      expect(instances).toEqual([
        expect.objectContaining({ port, pid: null, runtime: 'web', source: 'probe' }),
      ]);
    });
  });

  it('cleans a matched pid-file entry without stopping it when the recorded port is free', async () => {
    await withTempVarinDataDir(async () => {
      const port = await allocateLoopbackPort();
      const child = spawnVarinLikeIdleProcess();
      const pidFile = await getPidFilePath(port);
      const instanceFile = await getInstanceFilePath(port);
      try {
        await new Promise((resolve) => setTimeout(resolve, 150));
        fs.writeFileSync(pidFile, String(child.pid));
        fs.writeFileSync(instanceFile, JSON.stringify({ port, host: '127.0.0.1', launchMode: 'daemon' }, null, 2));

        const instance = await discoverUnconfirmedRegistryInstanceOnPort(port, { host: '127.0.0.1' });

        expect(instance).toBeNull();
        expect(fs.existsSync(pidFile)).toBe(false);
        expect(fs.existsSync(instanceFile)).toBe(false);
        expect(child.exitCode).toBeNull();
      } finally {
        child.kill('SIGKILL');
      }
    });
  });
});

describe('lifecycle commands with unmanaged explicit ports', () => {
  it('serve refuses to start on a live Varin port without requiring pid files', async () => {
    await withTempVarinDataDir(async () => {
      const server = await startMockVarinServer();
      try {
        await expect(commands.serve({ explicitPort: true, port: server.port, quiet: true })).rejects.toThrow(
          /already running on port/
        );
      } finally {
        await server.close();
      }
    });
  });

  it('status --port reports a live unmanaged server when the registry is empty', async () => {
    await withTempVarinDataDir(async () => {
      const server = await startMockVarinServer();
      try {
        const output = await captureStdout(() => commands.status({ explicitPort: true, port: server.port, json: true }));
        const payload = JSON.parse(output);
        expect(payload.state).toBe('running');
        expect(payload.runningCount).toBe(1);
        expect(payload.instances).toEqual([
          expect.objectContaining({ runtime: 'unmanaged', port: server.port, pid: null }),
        ]);
      } finally {
        await server.close();
      }
    });
  });

  it('stop --port reaches unmanaged shutdown when the registry is empty', async () => {
    await withTempVarinDataDir(async () => {
      const server = await startMockVarinServer();
      try {
        await commands.stop({ explicitPort: true, port: server.port, quiet: true, suppressQuietOutput: true });
        expect(server.shutdownRequested).toBe(true);
      } finally {
        await server.close();
      }
    });
  });

  it('stop --port can recover a matched pid-file instance whose HTTP endpoint is unresponsive', async () => {
    await withTempVarinDataDir(async () => {
      const port = await allocateLoopbackPort();
      const child = spawnVarinLikeHungServer(port);
      const pidFile = await getPidFilePath(port);
      const instanceFile = await getInstanceFilePath(port);
      try {
        expect(await waitForTcpPort(port)).toBe(true);
        fs.writeFileSync(pidFile, String(child.pid));
        fs.writeFileSync(instanceFile, JSON.stringify({ port, host: '127.0.0.1', launchMode: 'daemon' }, null, 2));

        await commands.stop({ explicitPort: true, port, host: '127.0.0.1', quiet: true, suppressQuietOutput: true });

        expect(fs.existsSync(pidFile)).toBe(false);
        expect(fs.existsSync(instanceFile)).toBe(false);
        expect(await waitForTcpPortClosed(port)).toBe(true);
      } finally {
        child.kill('SIGKILL');
      }
    });
  }, 12_000);

  it('plain stop ignores a stale CLI registry entry that resolves to desktop runtime', async () => {
    await withTempVarinDataDir(async () => {
      const server = await startMockVarinServer({ runtime: 'desktop' });
      const child = spawnVarinLikeIdleProcess();
      const pidFile = await getPidFilePath(server.port);
      const instanceFile = await getInstanceFilePath(server.port);
      try {
        await new Promise((resolve) => setTimeout(resolve, 150));
        fs.writeFileSync(pidFile, String(child.pid));
        fs.writeFileSync(instanceFile, JSON.stringify({ port: server.port, launchMode: 'daemon' }, null, 2));

        await commands.stop({ quiet: true, suppressQuietOutput: true });

        expect(server.shutdownRequested).toBe(false);
        expect(fs.existsSync(pidFile)).toBe(false);
        expect(fs.existsSync(instanceFile)).toBe(false);
      } finally {
        child.kill('SIGKILL');
        await server.close();
      }
    });
  });

  it('restart --port restarts a live unmanaged server through the shared explicit-port discovery path', async () => {
    await withTempVarinDataDir(async () => {
      const server = await startMockVarinServer();
      const calls: Array<['serve' | 'stop', number | undefined, string | undefined]> = [];
      const host = '127.0.0.1';
      try {
        const output = await captureStdout(() => commands.restart.call({
          stop: async (options: CliOptions) => {
            calls.push(['stop', options.port, options.host]);
          },
          serve: async (options: CliOptions) => {
            calls.push(['serve', options.port, options.host]);
            return options.port;
          },
        }, { explicitPort: true, port: server.port, host, json: true }));

        const payload = JSON.parse(output);
        expect(calls).toEqual([
          ['stop', server.port, host],
          ['serve', server.port, host],
        ]);
        expect(payload.restartedCount).toBe(1);
        expect(payload.results).toEqual([
          expect.objectContaining({ fromPort: server.port, toPort: server.port, ok: true }),
        ]);
      } finally {
        await server.close();
      }
    });
  });
});
