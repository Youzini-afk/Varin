/** Real Node pipes + HTTP listener; fixture substitutes only the expensive Host.
 * Native Catalog/worker acceptance remains with the existing kernel suites. */
import { afterEach, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { desktopHostEnvelope, type DesktopHostFrame } from '../../desktop-host-protocol.js';

const roots: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function launch() {
  const root = await mkdtemp(join(tmpdir(), 'varin-managed-host-test-')); roots.push(root);
  const source = `
    import http from 'node:http';
    import fs from 'node:fs/promises';
    import { runManagedDesktopHost } from ${JSON.stringify(new URL('../../desktop-host.ts', import.meta.url).href)};
    const server = http.createServer((_req, res) => res.end('original-owner'));
    await runManagedDesktopHost({ async start(options) {
      console.log('ordinary Host log'); process.stdout.write('direct library output\\n');
      await new Promise(resolve => server.listen(0, options.host, resolve));
      return { getPort: () => server.address().port, isReady: () => true, getTunnelUrl: () => null,
        getQuitRiskStatus: async () => ({ scheduledTasks: { running: 1 }, tunnel: { active: false } }),
        getDesktopLocalCredentials: async () => ({ clientToken: 'fixture-private-token' }),
        async stop() {
          await fs.writeFile(${JSON.stringify(join(root, 'draining'))}, 'started');
          while (true) { try { await fs.access(${JSON.stringify(join(root, 'release'))}); break; } catch { await new Promise(resolve => setTimeout(resolve, 10)); } }
          await new Promise(resolve => server.close(resolve));
          await fs.writeFile(${JSON.stringify(join(root, 'stopped'))}, 'drained');
        },
      };
    }});
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
    env: { ...process.env, VARIN_DATA_DIR: root, VARIN_NODE_PATH: process.execPath }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  }); children.push(child);
  let stderr = ''; child.stderr.on('data', data => { stderr += String(data); });
  const frames: DesktopHostFrame[] = [];
  let parseError: unknown;
  createInterface({ input: child.stdout }).on('line', line => { try { frames.push(JSON.parse(line)); } catch (error) { parseError = error; } });
  const exited = new Promise<number | null>(resolve => child.once('exit', resolve));
  const ready = () => frames.find(frame => frame.kind === 'event' && frame.event === 'ready');
  await expect.poll(() => ready() ?? (child.exitCode === null ? null : stderr)).toBeTruthy();
  expect(ready(), stderr).toBeTruthy();
  const payload = (ready() as { payload: { port: number; clientToken: string } }).payload;
  return { root, child, frames, exited, payload, get stderr() { return stderr; }, get parseError() { return parseError; } };
}
async function exists(file: string) { try { await readFile(file); return true; } catch { return false; } }

it('keeps stdout private and does not report stopped until the original process has drained', async () => {
  const f = await launch();
  expect(f.parseError).toBeUndefined();
  expect(f.stderr).toContain('ordinary Host log');
  expect(f.stderr).toContain('direct library output');
  expect(f.stderr).not.toContain('fixture-private-token');
  expect(await (await fetch(`http://127.0.0.1:${f.payload.port}`)).text()).toBe('original-owner');
  expect(JSON.parse(await readFile(join(f.root, 'settings.json'), 'utf8')).desktopLocalPort).toBe(f.payload.port);
  f.child.stdin.write(JSON.stringify({ ...desktopHostEnvelope, kind: 'request', id: 'shell:stop', method: 'stop' }) + '\n');
  await expect.poll(() => exists(join(f.root, 'draining'))).toBe(true);
  expect(f.child.exitCode).toBeNull();
  expect(f.frames.some(frame => frame.kind === 'response')).toBe(false);
  await writeFile(join(f.root, 'release'), 'release');
  expect(await f.exited).toBe(0);
  expect(await readFile(join(f.root, 'stopped'), 'utf8')).toBe('drained');
  expect(f.frames.at(-1)).toMatchObject({ kind: 'response', id: 'shell:stop', ok: true, result: { stopped: true } });
});

it('parent pipe EOF initiates the same real drain rather than orphaning the local Host', async () => {
  const f = await launch();
  f.child.stdin.end();
  await expect.poll(() => exists(join(f.root, 'draining'))).toBe(true);
  expect(f.child.exitCode).toBeNull();
  await writeFile(join(f.root, 'release'), 'release');
  expect(await f.exited).toBe(0);
  expect(await readFile(join(f.root, 'stopped'), 'utf8')).toBe('drained');
  expect(f.frames.filter(frame => frame.kind === 'event' && frame.event === 'ready')).toHaveLength(1);
});
