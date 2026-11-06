import { spawn, type ChildProcess, type Serializable } from 'node:child_process';
import { expect, it } from 'vitest';

type FixtureMessage = { kind: string; port?: number };
const loaderUrl = import.meta.resolve('tsx');
const runtimeUrl = new URL('./shutdown-runtime.ts', import.meta.url).href;

const nextFixtureMessage = (child: ChildProcess, phase: string, diagnostics: () => string): Promise<FixtureMessage> => new Promise((resolve, reject) => {
  const cleanup = () => { child.off('message', message); child.off('error', error); child.off('close', close); };
  const message = (value: Serializable) => { cleanup(); resolve(value as FixtureMessage); };
  const error = (cause: Error) => { cleanup(); reject(new Error(`Shutdown fixture failed before ${phase}: ${cause.message}\n${diagnostics()}`, { cause })); };
  // close, rather than exit, waits until captured stderr is drained, so an
  // import/startup failure reports its actual cause instead of a test timeout.
  const close = (code: number | null, signal: NodeJS.Signals | null) => {
    cleanup(); reject(new Error(`Shutdown fixture exited before ${phase} (code=${code}, signal=${signal})\n${diagnostics()}`));
  };
  child.once('message', message); child.once('error', error); child.once('close', close);
});

const completion = (child: ChildProcess) => new Promise<[number | null, NodeJS.Signals | null]>(resolve => {
  child.once('close', (code, signal) => resolve([code, signal]));
});

// Windows child.kill('SIGTERM') forcibly terminates the process; it does not
// deliver a POSIX signal handler. Exercise the same real shutdown owner through
// explicit IPC there, and test both triggers on POSIX without conflating them.
const triggers = process.platform === 'win32' ? ['explicit stop IPC'] as const : ['POSIX SIGTERM', 'explicit stop IPC'] as const;
it.each(triggers)('a real child using %s bounds a stuck owner, withdraws readiness, and exits nonzero without claiming store closure', async trigger => {
  const source = `
    import http from 'node:http';
    import { createGracefulShutdownRuntime } from ${JSON.stringify(runtimeUrl)};
    let draining = false;
    const server = http.createServer((_request, response) => {
      response.writeHead(draining ? 503 : 200); response.end(JSON.stringify({ ready: !draining }));
    });
    const runtime = createGracefulShutdownRuntime({
      process, shutdownTimeoutMs: 500,
      getExitOnShutdown: () => true, getIsShuttingDown: () => draining,
      setIsShuttingDown: value => { draining = value; process.send({ kind: 'draining' }); },
      scheduledTasksRuntime: { stop: () => new Promise(() => {}) },
      getTerminalRuntime: () => null, setTerminalRuntime() {}, getServer: () => server,
      getDocumentsAuthority: () => ({ dispose: () => process.send({ kind: 'unsafe-store-close' }) }),
      setDocumentsAuthority() {}, getUiAuthController: () => null, setUiAuthController() {},
      getActiveTunnelController: () => null, setActiveTunnelController() {}, tunnelAuthController: { clearActiveTunnel() {} },
    });
    process.on('SIGTERM', () => { void runtime.gracefulShutdown(); });
    process.on('message', message => { if (message?.kind === 'stop') void runtime.gracefulShutdown(); });
    server.listen(0, '127.0.0.1', () => process.send({ kind: 'ready', port: server.address().port }));
  `;
  const child = spawn(process.execPath, ['--import', loaderUrl, '--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const messages: FixtureMessage[] = [];
  let stdout = '', stderr = '';
  child.stdout!.on('data', bytes => { stdout += bytes; });
  child.stderr!.on('data', bytes => { stderr += bytes; });
  child.on('message', value => { messages.push(value as FixtureMessage); });
  const exit = completion(child);
  try {
    const ready = await nextFixtureMessage(child, 'ready IPC', () => stdout + stderr);
    expect(ready.kind).toBe('ready');
    const endpoint = `http://127.0.0.1:${ready.port}/health`;
    expect((await fetch(endpoint)).status).toBe(200);
    const draining = nextFixtureMessage(child, 'draining IPC', () => stdout + stderr);
    const started = performance.now();
    if (trigger === 'POSIX SIGTERM') child.kill('SIGTERM');
    else child.send({ kind: 'stop' });
    expect(await draining).toEqual({ kind: 'draining' });
    const health = await fetch(endpoint);
    expect(health.status).toBe(503); expect(await health.json()).toEqual({ ready: false });
    const [code, signal] = await exit;
    expect(code).toBe(1); expect(signal).toBeNull();
    expect(performance.now() - started).toBeLessThan(3000);
    expect(messages.some(message => message.kind === 'unsafe-store-close')).toBe(false);
    expect(stdout).not.toContain('Graceful shutdown complete');
    const summary = JSON.parse(stderr.split('\n').find(line => line.startsWith('[Shutdown] {'))!.slice('[Shutdown] '.length));
    expect(summary).toMatchObject({ outcome: 'incomplete', owner: 'scheduledTasks.stop', reason: 'deadline', deadlineMs: 500 });
    expect(summary.elapsedMs).toBeGreaterThanOrEqual(490);
  } finally {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit; }
  }
}, 15_000);

it('reports a real child import failure before readiness with the startup diagnostic', async () => {
  const missing = new URL('./missing-shutdown-runtime-for-failure-probe.ts', import.meta.url).href;
  const child = spawn(process.execPath, ['--import', loaderUrl, '--input-type=module', '-e', `import ${JSON.stringify(missing)};`], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr!.on('data', bytes => { stderr += bytes; });
  const exit = completion(child);
  try {
    await expect(nextFixtureMessage(child, 'ready IPC', () => stderr)).rejects.toThrow(/exited before ready IPC[\s\S]*ERR_MODULE_NOT_FOUND/);
    expect(await exit).toEqual([1, null]);
  } finally {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit; }
  }
});
