import { mkdtemp, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { hashScriptWorkerDirectory, scriptNodeSpawnInput } from './script-node-binding.js';

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
async function directory() {
  const value = await mkdtemp(join(tmpdir(), 'varin-script-binding-'));
  directories.push(value);
  return value;
}
async function put(root: string, path: string, contents: string | Uint8Array) {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents);
}

it('keeps identical worker trees stable across install paths, creation order and locale ordering', async () => {
  const first = await directory(), second = await directory();
  const files = [
    ['worker.js', 'import "./nested/evaluator.js";'],
    ['nested/evaluator.js', 'export const evaluate = () => 1;'],
    ['Z.js', 'export const upper = true;'],
    ['a.js', 'export const lower = true;'],
  ] as const;
  for (const [name, contents] of files) await put(first, name, contents);
  for (const [name, contents] of [...files].reverse()) await put(second, name, contents);
  const identity = await hashScriptWorkerDirectory(first);
  // An environment's locale cannot redefine the same installed evaluator's identity.
  vi.spyOn(String.prototype, 'localeCompare').mockImplementation(function (this: string, other: string) {
    return this < other ? 1 : this > other ? -1 : 0;
  });
  expect(await hashScriptWorkerDirectory(second)).toBe(identity);
  await put(second, 'worker.js.map', 'changed source mapping');
  await put(second, 'worker.d.ts', 'changed declarations');
  expect(await hashScriptWorkerDirectory(second)).toBe(identity);
});

it('invalidates worker identity on exact nested bytes, relative paths, additions and removals', async () => {
  const root = await directory();
  await put(root, 'worker.js', 'import "./nested/evaluator.js";');
  await put(root, 'nested/evaluator.js', Uint8Array.of(0xff));
  const original = await hashScriptWorkerDirectory(root);
  await put(root, 'nested/evaluator.js', Uint8Array.of(0xfe));
  expect(await hashScriptWorkerDirectory(root)).not.toBe(original);
  await put(root, 'nested/evaluator.js', Uint8Array.of(0xff));
  expect(await hashScriptWorkerDirectory(root)).toBe(original);
  await rename(join(root, 'nested/evaluator.js'), join(root, 'nested/renamed.js'));
  expect(await hashScriptWorkerDirectory(root)).not.toBe(original);
  await rename(join(root, 'nested/renamed.js'), join(root, 'nested/evaluator.js'));
  await put(root, 'additional.js', '');
  expect(await hashScriptWorkerDirectory(root)).not.toBe(original);
  await rm(join(root, 'additional.js'));
  expect(await hashScriptWorkerDirectory(root)).toBe(original);
  await rm(join(root, 'nested/evaluator.js'));
  expect(await hashScriptWorkerDirectory(root)).not.toBe(original);
  await expect(hashScriptWorkerDirectory(join(root, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('uses fresh executing-Host spawn inputs without inheriting its parent IPC channel', () => {
  const node = { executable: '/installed/node', worker_path: '/installed/worker.js', worker_identity: 'worker', configuration_identity: 'binding' };
  vi.stubEnv('NODE_CHANNEL_FD', '17');
  vi.stubEnv('ELECTRON_RUN_AS_NODE', '0');
  vi.stubEnv('VARIN_SCRIPT_BINDING_TEST', 'first');
  const first = scriptNodeSpawnInput(node);
  expect(first.command).toBe(node.executable);
  expect(first.args).toEqual(['--experimental-repl-await', node.worker_path]);
  expect(first.env).not.toContainEqual(expect.objectContaining({ name: 'NODE_CHANNEL_FD' }));
  expect(first.env).toContainEqual({ name: 'ELECTRON_RUN_AS_NODE', value: '1' });
  expect(first.env).toContainEqual({ name: 'VARIN_SCRIPT_BINDING_TEST', value: 'first' });
  vi.stubEnv('VARIN_SCRIPT_BINDING_TEST', 'second');
  expect(scriptNodeSpawnInput(node).env).toContainEqual({ name: 'VARIN_SCRIPT_BINDING_TEST', value: 'second' });
  expect(first.env).toContainEqual({ name: 'VARIN_SCRIPT_BINDING_TEST', value: 'first' });
  expect(process.env.ELECTRON_RUN_AS_NODE).toBe('0');
  expect(process.env.NODE_CHANNEL_FD).toBe('17');
});
