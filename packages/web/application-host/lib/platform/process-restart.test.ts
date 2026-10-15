import { expect, test } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProcessRestart } from './process-restart.js';

function controlled() {
  const child = new EventEmitter() as any;
  child.connected = true;
  const messages: any[] = [];
  child.send = (value: any) => { messages.push(value); queueMicrotask(() => child.emit('message', { kind: 'launched' })); };
  child.disconnect = () => { child.connected = false; };
  child.unref = () => {};
  let spawns = 0;
  return { child, messages, get spawns() { return spawns; }, spawn: (() => { spawns++; queueMicrotask(() => child.emit('message', { kind: 'ready' })); return child; }) as any };
}
test('concurrent restart requests share one real drain and never launch before it completes', async () => {
  const f = controlled(); let release!: () => void, entered!: () => void, stopped = 0, exits = 0;
  const stopping = new Promise<void>(resolve => { entered = resolve; });
  const restart = createProcessRestart({ spawn: f.spawn, stop: async () => { stopped++; entered(); await new Promise<void>(resolve => { release = resolve; }); }, exit: () => { exits++; } });
  const first = restart(), second = restart();
  await stopping; expect(f.messages).toEqual([]); expect(stopped).toBe(1);
  release(); await Promise.all([first, second]);
  expect(f.spawns).toBe(1); expect(f.messages).toHaveLength(1); expect(exits).toBe(1);
});
test('failed physical stop never starts a replacement or exits the original process', async () => {
  const f = controlled(); let exited = false;
  const restart = createProcessRestart({ spawn: f.spawn, stop: async () => { throw new Error('writer still active'); }, exit: () => { exited = true; } });
  await expect(restart()).rejects.toThrow('writer still active');
  expect(f.messages).toEqual([]); expect(f.child.connected).toBe(false); expect(exited).toBe(false);
});
test('the actual relay starts a fresh process only after the stop fact has been written', async () => {
  const root = await mkdtemp(join(tmpdir(), 'varin-restart-'));
  const stopped = join(root, 'stopped'), result = join(root, 'result');
  try {
    const args = ['-e', `require('node:fs').writeFileSync(${JSON.stringify(result)}, require('node:fs').readFileSync(${JSON.stringify(stopped)}, 'utf8'))`];
    await createProcessRestart({ stop: () => writeFile(stopped, 'drained'), args, exit() {} })();
    // Waiting here observes the replacement's output; it never launches another copy.
    let body: string | undefined;
    while (body === undefined) { try { body = await readFile(result, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await new Promise(resolve => setTimeout(resolve, 10)); } }
    expect(body).toBe('drained');
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('relay loss during physical stop is retained without starting another Host or releasing the drain', async () => {
  const f = controlled(); let release!: () => void, entered!: () => void, exits = 0;
  const stopping = new Promise<void>(resolve => { entered = resolve; });
  const restart = createProcessRestart({ spawn: f.spawn, stop: async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); }, exit: () => { exits++; } });
  let settled = false; const pending = restart().finally(() => { settled = true; });
  await stopping; f.child.connected = false; f.child.emit('error', new Error('relay died')); f.child.emit('exit', 1);
  await Promise.resolve(); expect(settled).toBe(false); expect(f.messages).toEqual([]);
  release(); await expect(pending).rejects.toThrow('relaunch failed'); expect(exits).toBe(0);
});
