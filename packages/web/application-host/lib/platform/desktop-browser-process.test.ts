import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { desktopHostEnvelope, type DesktopHostFrame } from '../../desktop-host-protocol.js';

it('starts only the lazy browser coordinator and refuses local Host grants in a remote-only client', async () => {
  const root = await mkdtemp(join(tmpdir(), 'varin-browser-only-'));
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../../desktop-browser.ts', import.meta.url))], {
    env: { ...process.env, VARIN_DATA_DIR: root, VARIN_NODE_PATH: process.execPath }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  const frames: DesktopHostFrame[] = []; let stderr = '';
  child.stderr.on('data', value => { stderr += String(value); });
  createInterface({ input: child.stdout }).on('line', line => frames.push(JSON.parse(line)));
  const exited = new Promise<number | null>(resolve => child.once('exit', resolve));
  try {
    await expect.poll(() => frames.some(frame => frame.kind === 'event' && frame.event === 'ready') || child.exitCode !== null).toBe(true);
    expect(frames[0], stderr).toMatchObject({ kind: 'event', event: 'ready', payload: { mode: 'browser' } });
    expect((frames[0] as { payload: object }).payload).not.toHaveProperty('origin');
    expect(await readdir(root)).toEqual([]);
    expect(frames.some(frame => frame.kind === 'request')).toBe(false);
    child.stdin.write(JSON.stringify({ ...desktopHostEnvelope, kind: 'request', id: 'shell:grant', method: 'fileGrant', params: { path: '/not-a-local-host' } }) + '\n');
    await expect.poll(() => frames.find(frame => frame.kind === 'response' && frame.id === 'shell:grant')).toMatchObject({ ok: false, error: { message: 'Local Application Host file grants are unavailable' } });
    child.stdin.write(JSON.stringify({ ...desktopHostEnvelope, kind: 'request', id: 'shell:stop', method: 'stop' }) + '\n');
    expect(await exited).toBe(0);
    expect(await readdir(root)).toEqual([]);
    expect(frames.at(-1)).toMatchObject({ kind: 'response', id: 'shell:stop', ok: true });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited; await rm(root, { recursive: true, force: true });
  }
});
