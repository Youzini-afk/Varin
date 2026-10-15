import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { createWorkspaceWatcher, type WatchEvent } from './watch.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const kernelPath = process.env.VARIN_TEST_KERNEL_PATH ?? path.join(repository, 'kernel/target/release/varin-kernel');
const available = fs.existsSync(kernelPath);
if (process.env.VARIN_REQUIRE_RELEASE_KERNEL === '1' && !available) throw new Error('Directory observation requires a built kernel');

it.skipIf(process.platform !== 'linux' || !available)('delivers the native namespace fence through the original Host watcher', async ({ skip }) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'varin-native-watch-'));
  const events: WatchEvent[] = [];
  const invalidated: Array<string | undefined> = [];
  vi.stubEnv('VARIN_KERNEL_PATH', kernelPath);
  const controller = createWorkspaceWatcher({ workspaceId: 'directory-fence', rootPath: root,
    fsModule: fs, fsPromises: fs.promises, pathModule: path, onEvent: event => events.push(event),
    onNamespaceInvalidated: file => invalidated.push(file) });
  try {
    await controller.ready;
    await controller.settle();
    // This is capability-scoped evidence; unsupported CI temp filesystems keep
    // the original Node hints and do not claim native namespace coverage.
    if (controller.coverage.namespace !== 'complete') return skip();
    const original = controller.position;
    await fs.promises.mkdir(path.join(root, 'nested'));
    await fs.promises.writeFile(path.join(root, 'nested/file'), 'first');
    await controller.settle();
    expect(controller.coverage).toMatchObject({ namespace: 'complete', content: 'unknown' });
    expect(invalidated).toContain('nested');
    expect(events.some(event => event.resource?.resourceId === 'nested')).toBe(true);
    events.length = 0;
    await fs.promises.writeFile(path.join(root, 'nested/file'), 'second');
    await controller.settle();
    expect(events).toContainEqual(expect.objectContaining({ kind: 'changed', resource: { workspaceId: 'directory-fence', resourceId: 'nested/file' } }));
    expect(controller.position).toMatchObject({ sourceId: original.sourceId, generation: original.generation });
    await fs.promises.unlink(path.join(root, 'nested/file'));
    await controller.settle();
    expect(events).toContainEqual(expect.objectContaining({ kind: 'deleted', resource: { workspaceId: 'directory-fence', resourceId: 'nested/file' } }));
    controller.close();
    expect(controller.connected).toBe(false);
    expect(controller.coverage.namespace).toBe('unknown');
  } finally {
    controller.close();
    vi.unstubAllEnvs();
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});
