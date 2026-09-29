import { afterEach, describe, expect, test } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http, { type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, type Readable, type Writable } from 'node:stream';
import type { SpawnOptions } from 'node:child_process';

import { HostSshManager, type SshChildProcess, type SshInstance, type ParsedSshCommand } from './ssh-manager.js';

interface TestSshChildProcess extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  exitCode: number | null;
  kill(signal?: NodeJS.Signals): boolean;
}

const servers: Server[] = [];
const tempDirs: string[] = [];

const createChild = (): TestSshChildProcess => {
  const child = new EventEmitter() as TestSshChildProcess;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.kill = () => {
    child.exitCode = 0;
    return true;
  };
  return child;
};

// Adapt TestSshChildProcess to the SshChildProcess contract expected by the manager.
// The real child_process.ChildProcess satisfies SshChildProcess directly; this helper
// bridges the test's EventEmitter-based stand-in to the same structural shape.
class TestSshChildProcessAdapter implements SshChildProcess {
  stderr: Pick<Readable, 'on'>;
  stdin: Pick<Writable, 'write' | 'end'>;
  stdout: Pick<Readable, 'on'>;
  constructor(private readonly inner: TestSshChildProcess) {
    this.stderr = inner.stderr as Pick<Readable, 'on'>;
    this.stdin = inner.stdin as Pick<Writable, 'write' | 'end'>;
    this.stdout = inner.stdout as Pick<Readable, 'on'>;
  }
  get exitCode(): number | null {
    return this.inner.exitCode;
  }
  kill(signal?: NodeJS.Signals): boolean {
    return this.inner.kill(signal);
  }
  on(event: 'close', listener: (code: number | null) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'close' | 'error', listener: ((code: number | null) => void) | ((error: Error) => void)): this {
    this.inner.on(event, listener as never);
    return this;
  }
}

const asSshChild = (child: TestSshChildProcess): SshChildProcess => new TestSshChildProcessAdapter(child);

interface SpawnCall {
  command: string;
  args: string[];
  options: SpawnOptions;
}

const listen = async (server: Server): Promise<string> => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
  return `http://127.0.0.1:${address.port}`;
};

const readBody = async (req: http.IncomingMessage): Promise<string> => {
  let body = '';
  for await (const chunk of req) body += chunk.toString();
  return body;
};

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (!server) continue;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

describe('HostSshManager', () => {
  test('disconnecting while configuration resolves prevents late connection startup and persists the intent', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'varin-ssh-cancel-'));
    tempDirs.push(tempDir);
    const manager = new HostSshManager({ settingsFilePath: path.join(tempDir, 'settings.json'), appVersion: 'test', emit: () => {},
      spawn: () => { throw new Error('Cancelled connection must not start a process'); } });
    await manager.setInstances({ instances: [{ id: 'remote', sshCommand: 'ssh user@example.test' }] });
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    manager.resolveSshConfig = async () => { entered(); await new Promise<void>((resolve) => { release = resolve; }); return new Map(); };
    const connecting = manager.connect('remote');
    const rejected = expect(connecting).rejects.toThrow('cancelled');
    await started;
    const disconnecting = manager.disconnect('remote');
    release();
    await Promise.all([rejected, disconnecting]);
    expect(manager.settingsStore.readSync().hostSshConnections).toEqual([]);
    expect((await manager.statusesWithDefaults('remote'))[0]?.phase).toBe('idle');
    await manager.shutdownAll();
    await expect(manager.connect('remote')).rejects.toThrow('stopped');
  });

  test('restores explicitly connected targets in the Host without a renderer', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'varin-ssh-restore-'));
    tempDirs.push(tempDir);
    const manager = new HostSshManager({ settingsFilePath: path.join(tempDir, 'settings.json'), appVersion: 'test', emit: () => {} });
    await manager.setInstances({ instances: [{ id: 'remote', sshCommand: 'ssh user@example.test' }] });
    await manager.settingsStore.update((root) => { root.hostSshConnections = ['remote', 'removed']; });
    const restored: string[] = [];
    manager.connectBlocking = async (instance) => { restored.push(instance.id); };
    await manager.restore();
    expect(restored).toEqual(['remote']);
    await manager.shutdownAll();
    expect(manager.settingsStore.readSync().hostSshConnections).toContain('remote');
  });

  test('runs Windows SSH commands without ControlMaster and hides the process window', async () => {
    const calls: SpawnCall[] = [];
    const manager = new HostSshManager({
      settingsFilePath: path.join(os.tmpdir(), 'unused-settings.json'),
      appVersion: '0.0.0-test',
      emit: () => undefined,
      platform: 'win32',
      spawn: (command: string, args: string[], options: SpawnOptions): SshChildProcess => {
        calls.push({ command, args, options });
        const child = createChild();
        queueMicrotask(() => {
          child.stdout.end('Linux\n');
          child.exitCode = 0;
          child.emit('close', 0);
        });
        return asSshChild(child);
      },
    });
    const parsed: ParsedSshCommand = { destination: 'user@example.test', args: [] };

    await expect(manager.runRemoteCommand(parsed, 'C:\\Temp\\unused.sock', 'uname -s')).resolves.toBe('Linux\n');

    expect(calls).toHaveLength(1);
    const call0 = calls[0];
    if (!call0) throw new Error('Expected spawn call');
    expect(call0.command).toBe('ssh');
    expect(call0.options.windowsHide).toBe(true);
    expect(call0.args).toContain('ControlMaster=no');
    expect(call0.args).toContain('ControlPath=none');
    expect(call0.args).toContain('StrictHostKeyChecking=accept-new');
    expect(call0.args).not.toContain('ControlPath=C:\\Temp\\unused.sock');
  });

  test('creates a PowerShell-backed askpass helper on Windows', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'varin-ssh-askpass-test-'));
    tempDirs.push(tempDir);
    const manager = new HostSshManager({
      settingsFilePath: path.join(tempDir, 'settings.json'),
      appVersion: '0.0.0-test',
      emit: () => undefined,
      platform: 'win32',
    });

    const result = await manager.writeAskpassFiles(tempDir);

    expect(path.basename(result.askpassPath)).toBe('askpass.cmd');
    expect(result.cleanupPaths.map((filePath) => path.basename(filePath))).toEqual(['askpass.cmd', 'askpass.ps1']);
    expect(await fsp.readFile(path.join(tempDir, 'askpass.cmd'), 'utf8')).toContain('WindowsPowerShell');
    expect(await fsp.readFile(path.join(tempDir, 'askpass.ps1'), 'utf8')).toContain('VARIN_SSH_ASKPASS_VALUE');
  });

  test('runs each Windows port forward as an independent hidden SSH process', async () => {
    const calls: SpawnCall[] = [];
    const manager = new HostSshManager({
      settingsFilePath: path.join(os.tmpdir(), 'unused-settings.json'),
      appVersion: '0.0.0-test',
      emit: () => undefined,
      platform: 'win32',
      spawn: (command: string, args: string[], options: SpawnOptions): SshChildProcess => {
        calls.push({ command, args, options });
        return asSshChild(createChild());
      },
    });
    const parsed: ParsedSshCommand = { destination: 'user@example.test', args: [] };
    manager.sshAuth.set(parsed, {
      askpassPath: 'C:\\Varin\\askpass.cmd',
      sshPassword: 'secret-value',
      children: new Set(),
    });

    await manager.spawnMainForward(parsed, 'C:\\Temp\\unused.sock', '127.0.0.1', 3000, 4000);
    await manager.spawnExtraForward(parsed, 'C:\\Temp\\unused.sock', {
      id: 'dynamic-1',
      type: 'dynamic',
      enabled: true,
      localHost: '127.0.0.1',
      localPort: 5000,
    });

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.command).toBe('ssh');
      expect(call.args).toContain('ControlPath=none');
      expect(call.args).toContain('-N');
      expect(call.options.windowsHide).toBe(true);
      const env = call.options.env;
      expect(env?.SSH_ASKPASS).toBe('C:\\Varin\\askpass.cmd');
      expect(env?.VARIN_SSH_ASKPASS_VALUE).toBe('secret-value');
    }
    const call0 = calls[0];
    const call1 = calls[1];
    if (!call0 || !call1) throw new Error('Expected two spawn calls');
    expect(call0.args).toContain('-L');
    expect(call1.args).toContain('-D');
  });

  test('keeps ControlMaster-backed forwarding on non-Windows platforms', async () => {
    const calls: SpawnCall[] = [];
    const manager = new HostSshManager({
      settingsFilePath: path.join(os.tmpdir(), 'unused-settings.json'),
      appVersion: '0.0.0-test',
      emit: () => undefined,
      platform: 'darwin',
      spawn: (command: string, args: string[], options: SpawnOptions): SshChildProcess => {
        calls.push({ command, args, options });
        return asSshChild(createChild());
      },
    });
    const parsed: ParsedSshCommand = { destination: 'user@example.test', args: [] };

    await manager.spawnMainForward(parsed, '/tmp/control.sock', '127.0.0.1', 3000, 4000);

    expect(calls).toHaveLength(1);
    const call0 = calls[0];
    if (!call0) throw new Error('Expected spawn call');
    expect(call0.args).toContain('ControlPath=/tmp/control.sock');
    expect(call0.args).not.toContain('ControlPath=none');
    expect(call0.options.windowsHide).toBeUndefined();
  });

  test('stops in-flight commands and forwards when disconnecting Windows SSH', async () => {
    const killedChildren: TestSshChildProcess[] = [];
    const spawnedChildren: TestSshChildProcess[] = [];
    const manager = new HostSshManager({
      settingsFilePath: path.join(os.tmpdir(), 'unused-settings.json'),
      appVersion: '0.0.0-test',
      emit: () => undefined,
      platform: 'win32',
      spawn: (): SshChildProcess => {
        const child = createChild();
        child.kill = () => {
          killedChildren.push(child);
          child.exitCode = 1;
          child.emit('close', 1);
          return true;
        };
        spawnedChildren.push(child);
        return asSshChild(child);
      },
    });
    const parsed: ParsedSshCommand = { destination: 'user@example.test', args: [] };
    const mainForward = createChild();
    const extraForward = createChild();
    for (const child of [mainForward, extraForward]) {
      child.kill = () => {
        killedChildren.push(child);
        child.exitCode = 0;
        return true;
      };
    }
    manager.sshAuth.set(parsed, {
      askpassPath: 'C:\\Varin\\askpass.cmd',
      sshPassword: null,
      children: new Set(),
    });
    manager.sessions.set('ssh-1', {
      instance: {
        id: 'ssh-1',
        sshCommand: 'ssh user@example.test',
        sshParsed: parsed,
        connectionTimeoutSec: 30,
        localForward: { bindHost: '127.0.0.1' },
        portForwards: [],
        remoteVarin: { installMethod: 'npm', keepRunning: true, mode: 'external', uploadBundleOverSsh: false },
        auth: {},
      } as SshInstance,
      parsed,
      controlPath: 'C:\\Temp\\unused.sock',
      askpassCleanupPaths: [],
      startedByUs: false,
      remotePort: null,
      master: null,
      mainForward: asSshChild(mainForward),
      extraForwards: [{ id: 'dynamic-1', child: asSshChild(extraForward) }],
      mainForwardDetached: false,
      localPort: null,
      sessionDir: '',
      clientToken: '',
    });

    const commandState: { error: Error | null } = { error: null };
    const command = manager.runRemoteCommand(parsed, 'C:\\Temp\\unused.sock', 'uname -s').catch((error: unknown) => {
      commandState.error = error as Error;
    });
    await manager.disconnectInternal('ssh-1', false);

    await command;
    expect(commandState.error?.message).toBe('Remote command failed');
    expect(spawnedChildren).toHaveLength(1);
    const spawned0 = spawnedChildren[0];
    if (!spawned0) throw new Error('Expected spawned child');
    expect(new Set(killedChildren)).toEqual(new Set([spawned0, mainForward, extraForward]));
    expect(manager.sessions.has('ssh-1')).toBe(false);
  });

  test('reports bounded, sanitized, and redacted SSH master stderr when startup fails', async () => {
    const manager = new HostSshManager({
      settingsFilePath: path.join(os.tmpdir(), 'unused-settings.json'),
      appVersion: '0.0.0-test',
      emit: () => undefined,
      spawn: (): SshChildProcess => {
        const child = createChild();
        queueMicrotask(() => {
          child.exitCode = 1;
          child.emit('close', 1);
        });
        return asSshChild(child);
      },
    });
    const parsed: ParsedSshCommand = { destination: 'user@example.test', args: [] };
    const master = createChild();
    const masterChild = asSshChild(master);
    manager.sshAuth.set(parsed, {
      askpassPath: '/tmp/askpass.sh',
      sshPassword: 'secret-value',
      children: new Set(),
    });
    manager.trackSshProcess(masterChild, parsed);
    master.stderr.write(`muxclient socket failed: secret-value\u0007${'x'.repeat(3000)}`);
    master.exitCode = 255;

    try {
      await manager.waitForMasterReady(parsed, '/tmp/control.sock', 1, masterChild);
      throw new Error('Expected SSH master startup to fail');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toMatch(/^muxclient socket failed: \[redacted\]/);
      expect(message).not.toContain('secret-value');
      expect(message).not.toContain('\u0007');
      expect(message.length).toBeLessThanOrEqual(2000);
    }
  });

  test('stores a client token for forwarded Varin hosts when UI password is configured', async () => {
    let loginPayload: Record<string, unknown> | null = null;
    const server = http.createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/auth/session') {
        loginPayload = JSON.parse(await readBody(req));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ authenticated: true, clientToken: 'ssh-client-token' }));
        return;
      }
      res.writeHead(404).end();
    });
    const localUrl = await listen(server);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'varin-ssh-manager-test-'));
    tempDirs.push(tempDir);
    const settingsFilePath = path.join(tempDir, 'settings.json');
    const manager = new HostSshManager({
      settingsFilePath,
      appVersion: '0.0.0-test',
      emit: () => undefined,
    });

    const token = await manager.issueClientToken(localUrl, 'ui-secret');
    await manager.updateHostRuntime('ssh-1', 'SSH Host', localUrl, token);

    const settings = JSON.parse(fs.readFileSync(settingsFilePath, 'utf8'));
    expect(loginPayload).toMatchObject({
      password: 'ui-secret',
      trustDevice: true,
      issueClientToken: true,
    });
    expect(settings.desktopHosts).toEqual([{ id: 'ssh-1', label: 'SSH Host', url: localUrl, apiUrl: localUrl, clientToken: 'ssh-client-token' }]);
  });
});
