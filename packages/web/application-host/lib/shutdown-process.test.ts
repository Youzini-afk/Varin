import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it('a real SIGTERM bounds a stuck owner, withdraws readiness, and exits nonzero without claiming store closure', async () => {
  const runtimeUrl = pathToFileURL(resolve('packages/web/application-host/lib/shutdown-runtime.ts')).href;
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
    server.listen(0, '127.0.0.1', () => process.send({ kind: 'ready', port: server.address().port }));
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const messages: Array<{ kind: string; port?: number }> = [];
  let stdout = '', stderr = '';
  child.stdout!.on('data', bytes => { stdout += bytes; });
  child.stderr!.on('data', bytes => { stderr += bytes; });
  child.on('message', value => { messages.push(value as { kind: string; port?: number }); });
  const exit = once(child, 'exit');
  try {
    const first = await once(child, 'message');
    const ready = first[0] as { kind: string; port: number };
    expect(ready.kind).toBe('ready');
    const endpoint = `http://127.0.0.1:${ready.port}/health`;
    expect((await fetch(endpoint)).status).toBe(200);
    const draining = once(child, 'message');
    const started = performance.now();
    child.kill('SIGTERM');
    expect((await draining)[0]).toEqual({ kind: 'draining' });
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
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit; }
  }
}, 15_000);
