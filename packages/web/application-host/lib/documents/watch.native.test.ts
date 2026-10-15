import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorkspaceWatcher, type WatchEvent } from './watch.js';

const cleanups: Array<() => Promise<unknown> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'varin-directory-watch-'));
  cleanups.push(() => fs.promises.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  await fs.promises.mkdir(workspace);
  const watch = (rootPath = workspace) => {
    const events: WatchEvent[] = [];
    const controller = createWorkspaceWatcher({ workspaceId: 'watch-test', rootPath, fsModule: fs,
      fsPromises: fs.promises, pathModule: path, onEvent: event => events.push(event) });
    cleanups.push(() => controller.close());
    return { controller, events };
  };
  return { root, workspace, watch };
}

describe.skipIf(process.platform !== 'win32')('Windows directory notifications', () => {
  it('ignores reads and enumeration while observing content, names and directory attributes', async () => {
    const f = await fixture();
    const directory = path.join(f.workspace, 'src');
    const file = path.join(directory, '..sample-🎉.txt');
    await fs.promises.mkdir(directory);
    await fs.promises.writeFile(file, 'original');
    const { controller, events } = f.watch();
    await controller.ready;
    await controller.settle();
    const baseline = controller.position;
    await fs.promises.readdir(f.workspace);
    await fs.promises.readdir(directory);
    await fs.promises.readFile(file);
    await controller.settle();
    expect(controller.position).toEqual(baseline);
    await fs.promises.writeFile(file, 'changed');
    await controller.settle();
    expect(events).toContainEqual(expect.objectContaining({ kind: 'changed', resource: { workspaceId: 'watch-test', resourceId: 'src/..sample-🎉.txt' } }));
    const renamed = path.join(f.workspace, '..renamed.txt');
    await fs.promises.rename(file, renamed);
    await controller.settle();
    expect(events).toContainEqual(expect.objectContaining({ kind: 'deleted', resource: { workspaceId: 'watch-test', resourceId: 'src/..sample-🎉.txt' } }));
    expect(events).toContainEqual(expect.objectContaining({ kind: 'created', resource: { workspaceId: 'watch-test', resourceId: '..renamed.txt' } }));
    events.length = 0;
    try {
      await fs.promises.chmod(directory, 0o444);
      await controller.settle();
      expect(events).toContainEqual(expect.objectContaining({ kind: 'invalidated', resource: { workspaceId: 'watch-test', resourceId: 'src' } }));
    } finally { await fs.promises.chmod(directory, 0o666); }
  });

  it('invalidates root metadata and replacement without losing other subscriptions', async () => {
    const f = await fixture();
    const first = f.watch(), second = f.watch();
    await Promise.all([first.controller.ready, second.controller.ready]);
    try {
      await fs.promises.chmod(f.workspace, 0o444);
      await first.controller.settle();
      expect(first.events).toContainEqual(expect.objectContaining({ kind: 'reset' }));
    } finally { await fs.promises.chmod(f.workspace, 0o666); }
    first.controller.close();
    const missing = f.watch(path.join(f.root, 'missing'));
    await expect(missing.controller.ready).rejects.toThrow();
    await second.controller.settle();
    const before = second.controller.position;
    await fs.promises.rename(f.workspace, path.join(f.root, 'moved'));
    await fs.promises.mkdir(f.workspace);
    await expect.poll(() => second.controller.position.generation).toBeGreaterThan(before.generation);
    second.controller.reconnect();
    await second.controller.ready;
    await fs.promises.writeFile(path.join(f.workspace, 'replacement.txt'), 'replacement');
    await second.controller.settle();
    expect(second.events).toContainEqual(expect.objectContaining({ resource: { workspaceId: 'watch-test', resourceId: 'replacement.txt' } }));
  });

  it('settles pending readiness and flush callers when their subscription closes', async () => {
    const f = await fixture();
    const opening = f.watch();
    opening.controller.close();
    await expect(opening.controller.ready).rejects.toThrow('closed');
    const active = f.watch();
    await active.controller.ready;
    const pending = active.controller.settle();
    active.controller.close();
    await expect(pending).rejects.toThrow();
  });
});
