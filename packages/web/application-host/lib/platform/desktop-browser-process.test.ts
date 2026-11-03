import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { desktopHostEnvelope, type DesktopHostFrame } from '../../desktop-host-protocol.js';

it('starts only the lazy browser coordinator and refuses local Host grants in a remote-only client', async ({ onTestFinished }) => {
  const root = await mkdtemp(join(tmpdir(), 'varin-browser-only-'));
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../../desktop-browser.ts', import.meta.url))], {
    env: { ...process.env, VARIN_DATA_DIR: root, VARIN_NODE_PATH: process.execPath }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  const frames: DesktopHostFrame[] = []; let stderr = '';
  child.stderr.on('data', value => { stderr += String(value); });
  const waiting = new Set<{ matches(frame: DesktopHostFrame): boolean; resolve(frame: DesktopHostFrame): void; reject(error: Error): void }>();
  let terminalError: Error | undefined;
  const fail = (error: Error) => {
    terminalError = error;
    for (const waiter of waiting) waiter.reject(error);
    waiting.clear();
  };
  child.once('error', fail);
  // `close` also waits for stdout to drain, so the final response is observable
  // before asserting that the original browser process has finished.
  const exited = new Promise<number | null>(resolve => child.once('close', (code, signal) => {
    fail(new Error(`Browser process closed (${code ?? signal}): ${stderr}`)); resolve(code);
  }));
  createInterface({ input: child.stdout }).on('line', line => {
    try {
      const frame = JSON.parse(line) as DesktopHostFrame; frames.push(frame);
      for (const waiter of waiting) {
        if (waiter.matches(frame)) { waiting.delete(waiter); waiter.resolve(frame); }
      }
    } catch { fail(new Error('Private browser pipe contained non-protocol data')); }
  });
  let cleaning: Promise<void> | undefined;
  const cleanup = () => cleaning ??= (async () => {
    // Vitest's deadline does not cancel this async test body. The finish hook
    // rejects a pending frame wait, kills the original child and awaits pipe
    // closure even when no ready frame arrived and the body's finally has not run.
    fail(new Error('Browser process fixture is closing'));
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    await rm(root, { recursive: true, force: true });
  })();
  onTestFinished(cleanup);
  // Cold Node/tsx imports may exceed Vitest's short poll timeout under the full
  // platform suite. Wait for the real frame; timeout cleanup is registered above.
  const nextFrame = (matches: (frame: DesktopHostFrame) => boolean): Promise<DesktopHostFrame> => {
    const existing = frames.find(matches);
    if (existing) return Promise.resolve(existing);
    if (terminalError) return Promise.reject(terminalError);
    return new Promise((resolve, reject) => waiting.add({ matches, resolve, reject }));
  };
  try {
    const ready = await nextFrame(frame => frame.kind === 'event' && frame.event === 'ready');
    expect(ready, stderr).toMatchObject({ kind: 'event', event: 'ready', payload: { mode: 'browser' } });
    expect((ready as { payload: object }).payload).not.toHaveProperty('origin');
    expect(await readdir(root)).toEqual([]);
    expect(frames.some(frame => frame.kind === 'request')).toBe(false);
    child.stdin.write(JSON.stringify({ ...desktopHostEnvelope, kind: 'request', id: 'shell:grant', method: 'fileGrant', params: { path: '/not-a-local-host' } }) + '\n');
    expect(await nextFrame(frame => frame.kind === 'response' && frame.id === 'shell:grant')).toMatchObject({ ok: false, error: { message: 'Local Application Host file grants are unavailable' } });
    child.stdin.write(JSON.stringify({ ...desktopHostEnvelope, kind: 'request', id: 'shell:stop', method: 'stop' }) + '\n');
    expect(await exited).toBe(0);
    expect(await readdir(root)).toEqual([]);
    expect(frames.at(-1)).toMatchObject({ kind: 'response', id: 'shell:stop', ok: true });
  } finally { await cleanup(); }
});
