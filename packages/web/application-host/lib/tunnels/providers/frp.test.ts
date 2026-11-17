import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startFrpTunnel, type FrpTunnelConfiguration, type FrpTunnelDependencies, type FrpSpawnOptions } from './frp.js';

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  signals: Array<NodeJS.Signals | number> = [];
  autoClose = true;
  closed = false;
  kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    this.signals.push(signal);
    if (this.autoClose) queueMicrotask(() => this.finish());
    return true;
  }
  finish() {
    if (this.closed) return;
    this.closed = true;
    this.emit('exit', 0, null);
    this.stdout.end();
    this.stderr.end();
    this.emit('close', 0, null);
  }
  publish(name = 'varin-test') {
    this.stdout.write(`2026-11-17 10:00:00.000 [I] [client/control.go:159] [run-id] [${name}] start proxy success\n`);
  }
}

describe('existing FRP process adapter', () => {
  let root: string;
  let configuration: FrpTunnelConfiguration;
  const children: FakeChild[] = [];
  const token = 'private-token-{{ .Envs.OTHER_SECRET }}';

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-frpc-test-'));
    const executablePath = path.join(root, 'operator-frpc');
    const caFile = path.join(root, 'ca-{{literal}}.pem');
    await fs.writeFile(executablePath, 'fake process boundary, never executed', { mode: 0o700 });
    await fs.writeFile(caFile, 'provisioned CA fixture');
    configuration = {
      executablePath, server: { address: 'frps.example', port: 7000, tls: { caFile, serverName: 'frps.example' } },
      proxy: { name: 'varin-test', remotePort: 18080 }, tokenEnv: 'VARIN_FRP_TOKEN_HOME',
      publicOrigin: 'https://varin.example', backend: { originUrl: 'http://127.0.0.1:3903' },
    };
  });
  afterEach(async () => {
    for (const child of children.splice(0)) child.finish();
    vi.useRealTimers();
    await fs.rm(root, { recursive: true, force: true });
  });

  function begin(overrides: FrpTunnelDependencies = {}, input = configuration) {
    const child = new FakeChild();
    children.push(child);
    let resolveSpawn!: (value: { command: string; args: string[]; options: FrpSpawnOptions }) => void;
    const spawned = new Promise<{ command: string; args: string[]; options: FrpSpawnOptions }>(resolve => { resolveSpawn = resolve; });
    const starting = startFrpTunnel(input, {
      env: { VARIN_FRP_TOKEN_HOME: token, OTHER_SECRET: 'must-not-inherit', HTTP_PROXY: 'http://wrong-proxy', LANG: 'C.UTF-8' },
      tempDirectory: root, platform: 'linux',
      spawnProcess: (command, args, options) => { resolveSpawn({ command, args, options }); return child; },
      ...overrides,
    });
    void starting.catch(() => undefined);
    return { child, spawned, starting };
  }

  it('writes private authenticated TLS config, keeps credentials out of argv/environment, and waits for proxy publication', async () => {
    const run = begin();
    const launch = await run.spawned;
    expect(launch.command).toBe(configuration.executablePath);
    expect(launch.options.shell).toBe(false);
    expect(launch.options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
    expect(launch.options.env).toEqual({ LANG: 'C.UTF-8' });
    expect(launch.args).toEqual(['-c', path.join(launch.options.cwd, 'frpc.json')]);
    const text = await fs.readFile(launch.args[1]!, 'utf8');
    const document = JSON.parse(text);
    expect(text).not.toContain(token);
    expect(text).not.toContain('{{');
    expect(document).toMatchObject({
      serverAddr: 'frps.example', serverPort: 7000, loginFailExit: true,
      auth: { method: 'token', tokenSource: { type: 'file' } },
      log: { to: 'console', disablePrintColor: true },
      transport: { protocol: 'tcp', tls: { enable: true, trustedCaFile: configuration.server.tls.caFile, serverName: 'frps.example' } },
      proxies: [{ name: 'varin-test', type: 'tcp', localIP: '127.0.0.1', localPort: 3903, remotePort: 18080 }],
    });
    expect(document.auth.token).toBeUndefined();
    expect(document.webServer).toBeUndefined();
    expect(await fs.readFile(document.auth.tokenSource.file.path, 'utf8')).toBe(token);
    expect((await fs.stat(launch.options.cwd)).mode & 0o777).toBe(0o700);
    for (const file of [launch.args[1]!, document.auth.tokenSource.file.path]) expect((await fs.stat(file)).mode & 0o777).toBe(0o600);

    let settled = false;
    void run.starting.then(() => { settled = true; });
    run.child.stdout.write('[I] [client/service.go:294] login to server success, get run id [abc]\n');
    run.child.publish('some-other-proxy');
    run.child.stdout.write('unstructured [varin-test] start proxy success\n');
    run.child.stdout.write('[W] [client/service.go:305] server message: [I] [client/control.go:159] [varin-test] start proxy success\n');
    await Promise.resolve();
    expect(settled).toBe(false);
    run.child.publish();
    const controller = await run.starting;
    expect(controller.getState()).toBe('published');
    expect(controller.publicOrigin).toBe('https://varin.example');
    expect(controller.endpointVerification).toBe('unverified');
    await controller.stop();
    expect(controller.getState()).toBe('stopped');
    await expect(fs.stat(launch.options.cwd)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('handles split evidence but discards oversized lines without interpreting their suffix', async () => {
    const run = begin();
    await run.spawned;
    let settled = false;
    void run.starting.then(() => { settled = true; });
    run.child.stdout.write('x'.repeat(20_000));
    run.child.publish();
    await Promise.resolve();
    expect(settled).toBe(false);
    run.child.stdout.write('[I] [client/control.go:159] [varin-');
    run.child.stdout.write('test] start proxy ');
    run.child.stdout.write('success\r\n');
    await (await run.starting).stop();
  });

  it.each([
    ['[W] token in login doesn\'t match token from configuration SECRET', 'authentication_failed'],
    ['[W] x509: certificate signed by unknown authority SECRET', 'tls_failed'],
    ['[W] [varin-test] start error: port already used SECRET', 'publish_rejected'],
  ])('classifies failure privately and never retries: %s', async (line, code) => {
    const run = begin();
    const launch = await run.spawned;
    run.child.stderr.write(`${line}\n`);
    await expect(run.starting).rejects.toMatchObject({ code, retryable: false });
    await expect(run.starting).rejects.not.toThrow('SECRET');
    expect(run.child.signals).toEqual(['SIGTERM']);
    await expect(fs.stat(launch.options.cwd)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('times out unknown readiness formats, kills the pending child, and cleans its files', async () => {
    const run = begin({ startupTimeoutMs: 25 });
    const launch = await run.spawned;
    await expect(run.starting).rejects.toMatchObject({ code: 'startup_timeout' });
    expect(run.child.signals).toEqual(['SIGTERM']);
    await expect(fs.stat(launch.options.cwd)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('aborts pending startup promptly, but waits for actual child closure before resolving cleanup', async () => {
    const abort = new AbortController();
    const run = begin({ signal: abort.signal, shutdownGraceMs: 25 });
    run.child.autoClose = false;
    const launch = await run.spawned;
    abort.abort();
    expect(run.child.signals).toEqual(['SIGTERM']);
    let settled = false;
    void run.starting.catch(() => { settled = true; });
    run.child.emit('exit', 0, 'SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(run.child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(settled).toBe(false);
    expect((await fs.stat(launch.options.cwd)).isDirectory()).toBe(true);
    run.child.finish();
    await expect(run.starting).rejects.toMatchObject({ code: 'aborted' });
    await expect(fs.stat(launch.options.cwd)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not spawn for a pre-aborted request', async () => {
    const abort = new AbortController(); abort.abort();
    const spawnProcess = vi.fn();
    const run = begin({ signal: abort.signal, spawnProcess });
    await expect(run.starting).rejects.toMatchObject({ code: 'aborted' });
    expect(spawnProcess).not.toHaveBeenCalled();
    expect((await fs.readdir(root)).filter(file => file.startsWith('varin-frpc-'))).toEqual([]);
  });

  it('fences an abort during file preparation before launch and removes the already-written token', async () => {
    const abort = new AbortController(); const spawnProcess = vi.fn();
    const run = begin({ signal: abort.signal, spawnProcess, fs: { ...fs, writeFile: async (file, data, options) => {
      await fs.writeFile(file, data, options);
      if (String(file).endsWith('frpc.json')) abort.abort();
    } } });
    await expect(run.starting).rejects.toMatchObject({ code: 'aborted' });
    expect(spawnProcess).not.toHaveBeenCalled();
    expect((await fs.readdir(root)).filter(file => file.startsWith('varin-frpc-'))).toEqual([]);
  });

  it.each(['control message dispatcher exited', 'heartbeat timeout', 'try to connect to server...'])('reports %s once and stops built-in reconnection before handing recovery to Host', async (event) => {
    const run = begin(); await run.spawned; run.child.publish();
    const controller = await run.starting;
    const first = vi.fn(); const removed = vi.fn();
    controller.onDisconnect(first);
    controller.onDisconnect(removed)();
    run.child.stderr.write(`[D] [client/control.go:263] ${event}\n`);
    run.child.stderr.write(`[D] [client/control.go:263] ${event}\n`);
    expect(first).toHaveBeenCalledTimes(1);
    expect(first.mock.calls[0]?.[0]).toMatchObject({ code: 'connection_lost', retryable: true });
    expect(removed).not.toHaveBeenCalled();
    const late = vi.fn(); controller.onDisconnect(late);
    expect(late).toHaveBeenCalledTimes(1);
    await controller.stop();
    expect(run.child.signals).toEqual(['SIGTERM']);
  });

  it('treats unexpected exit as disconnect and cleans private state without a later stop caller', async () => {
    const run = begin(); const launch = await run.spawned; run.child.publish();
    const controller = await run.starting;
    const listener = vi.fn(); controller.onDisconnect(listener);
    run.child.finish();
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ code: 'process_exit' }));
    await controller.stop();
    await expect(fs.stat(launch.options.cwd)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('notifies every disconnect observer even if an earlier observer stops or throws', async () => {
    const run = begin(); await run.spawned; run.child.publish();
    const controller = await run.starting;
    controller.onDisconnect(() => { void controller.stop(); throw new Error('observer failure'); });
    const later = vi.fn(); controller.onDisconnect(later);
    run.child.stderr.write('[D] [client/control.go:263] control message dispatcher exited\n');
    expect(later).toHaveBeenCalledTimes(1);
    await controller.stop();
  });

  it('makes manual stop idempotent without emitting a disconnect or claiming kill delivery is exit', async () => {
    const run = begin(); run.child.autoClose = false; await run.spawned; run.child.publish();
    const controller = await run.starting; const listener = vi.fn(); controller.onDisconnect(listener);
    const first = controller.stop(); const second = controller.stop();
    expect(first).toBe(second); expect(run.child.signals).toEqual(['SIGTERM']);
    expect(controller.getState()).toBe('stopping'); expect(listener).not.toHaveBeenCalled();
    run.child.finish(); await first;
    expect(controller.getState()).toBe('stopped'); expect(listener).not.toHaveBeenCalled();
  });

  it.each(['http://192.168.1.1:3903', 'http://0.0.0.0:3903', 'http://localhost:3903', 'https://127.0.0.1:3903', 'http://127.0.0.1:3903/path'])('rejects non-loopback or non-origin backend %s before starting a process', async (originUrl) => {
    const spawnProcess = vi.fn();
    await expect(begin({ spawnProcess }, { ...configuration, backend: { originUrl } }).starting).rejects.toMatchObject({ code: 'invalid_configuration' });
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it('accepts an explicit IPv6 loopback backend', async () => {
    const run = begin({}, { ...configuration, backend: { originUrl: 'http://[::1]:3903' } });
    const launch = await run.spawned;
    expect(JSON.parse(await fs.readFile(launch.args[1]!, 'utf8')).proxies[0].localIP).toBe('::1');
    run.child.publish(); await (await run.starting).stop();
  });

  it('rejects unnamespaced credential references, missing credentials, relative binaries, and unsupported privacy semantics', async () => {
    await expect(begin({}, { ...configuration, tokenEnv: 'AWS_SECRET_ACCESS_KEY' }).starting).rejects.toMatchObject({ code: 'invalid_configuration' });
    await expect(begin({ env: {} }).starting).rejects.toMatchObject({ code: 'missing_credential' });
    await expect(begin({}, { ...configuration, executablePath: 'frpc' }).starting).rejects.toMatchObject({ code: 'invalid_configuration' });
    await expect(begin({ platform: 'win32' }).starting).rejects.toMatchObject({ code: 'unsupported_platform' });
  });

  it('requires an existing CA, explicit verified server name, and fixed nonzero remote port', async () => {
    const spawnProcess = vi.fn();
    await expect(begin({ spawnProcess }, { ...configuration, server: { ...configuration.server, tls: { ...configuration.server.tls, caFile: '' } } }).starting)
      .rejects.toMatchObject({ code: 'invalid_configuration' });
    await expect(begin({ spawnProcess }, { ...configuration, server: { ...configuration.server, tls: { ...configuration.server.tls, serverName: '' } } }).starting)
      .rejects.toMatchObject({ code: 'invalid_configuration' });
    await expect(begin({ spawnProcess }, { ...configuration, proxy: { ...configuration.proxy, remotePort: 0 } }).starting)
      .rejects.toMatchObject({ code: 'invalid_configuration' });
    await fs.rm(configuration.server.tls.caFile);
    await expect(begin({ spawnProcess }).starting).rejects.toMatchObject({ code: 'invalid_configuration' });
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it('cleans files after synchronous spawn failure without propagating secret-bearing diagnostics', async () => {
    const run = begin({ spawnProcess: () => { throw new Error(`launch failed ${token}`); } });
    await expect(run.starting).rejects.toMatchObject({ code: 'startup_failed' });
    await expect(run.starting).rejects.not.toThrow(token);
    expect((await fs.readdir(root)).filter(file => file.startsWith('varin-frpc-'))).toEqual([]);
  });

  it('waits for close after asynchronous spawn error and never exposes the raw process error', async () => {
    const run = begin(); const launch = await run.spawned;
    run.child.emit('error', new Error(`spawn failure ${token}`));
    await expect(run.starting).rejects.toMatchObject({ code: 'startup_failed' });
    await expect(run.starting).rejects.not.toThrow(token);
    await expect(fs.stat(launch.options.cwd)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not mark unknown login rejections as retryable network failures', async () => {
    const run = begin(); await run.spawned;
    run.child.stderr.write('[W] [client/service.go:305] connect to server error: server declined the client\n');
    await expect(run.starting).rejects.toMatchObject({ code: 'startup_failed', retryable: false });
  });

  it('cleans files after partial config preparation failure and makes no process', async () => {
    const spawnProcess = vi.fn();
    const run = begin({ spawnProcess, fs: { ...fs, writeFile: async (file, data, options) => {
      if (String(file).endsWith('frpc.json')) throw new Error(`disk full ${token}`);
      await fs.writeFile(file, data, options);
    } } });
    await expect(run.starting).rejects.toMatchObject({ code: 'startup_failed' });
    expect(spawnProcess).not.toHaveBeenCalled();
    expect((await fs.readdir(root)).filter(file => file.startsWith('varin-frpc-'))).toEqual([]);
  });

  it('retains a visible cleanup failure rather than falsely reporting stop success', async () => {
    const run = begin({ fs: { ...fs, rm: async () => { throw new Error('denied SECRET'); } } });
    await run.spawned; run.child.publish(); const controller = await run.starting;
    await expect(controller.stop()).rejects.toMatchObject({ code: 'cleanup_failed' });
    await expect(controller.stop()).rejects.not.toThrow('SECRET');
  });
});
