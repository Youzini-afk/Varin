import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { readProcThreadNames } from './proc-thread-names.test-helper.js';

const taskRoot = path.join('proc', '123', 'task');
const failure = (code: string) => Object.assign(new Error(code), { code });

it('retains exact worker names when a transient task exits after enumeration', async () => {
  const threads = new Map([
    ['1', 'compute-read-0\n'], ['2', 'compute-read-1\n'], ['3', 'compute-read-2\n'],
    ['4', 'compute-index\n'], ['5', 'runtime-worker\n'],
  ]);
  const access = vi.fn(async () => {});
  const names = await readProcThreadNames(taskRoot, {
    readdir: async () => ['1', '2', '3', '4', '5', '6'],
    readFile: async file => {
      const name = threads.get(path.basename(path.dirname(file)));
      if (name === undefined) throw failure('ENOENT');
      return name;
    },
    access,
  });
  expect(names).toEqual([...threads.values()].map(name => name.trim()));
  expect(access).toHaveBeenCalledExactlyOnceWith(taskRoot);
});

it.each(['EACCES', 'EPERM', 'EIO'])('does not suppress a thread name read failure with %s', async code => {
  const error = failure(code);
  await expect(readProcThreadNames(taskRoot, {
    readdir: async () => ['1'],
    readFile: async () => { throw error; },
    access: async () => {},
  })).rejects.toBe(error);
});

it('does not suppress a missing process during enumeration', async () => {
  const error = failure('ENOENT');
  await expect(readProcThreadNames(taskRoot, {
    readdir: async () => { throw error; },
    readFile: async () => 'compute-index\n',
    access: async () => {},
  })).rejects.toBe(error);
});

it.each([false, true])('rejects process exit after enumeration even if a thread read succeeds: %s', async readSucceeds => {
  const processExit = failure('ENOENT');
  await expect(readProcThreadNames(taskRoot, {
    readdir: async () => ['1'],
    readFile: async () => {
      if (!readSucceeds) throw failure('ENOENT');
      return 'compute-index\n';
    },
    access: async () => { throw processExit; },
  })).rejects.toBe(processExit);
});
