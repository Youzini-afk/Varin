import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { createKernelClient } from '../kernel/kernel-client.js';
import { createInteractiveUiRuntime } from './runtime.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const kernelPath = process.env.VARIN_TEST_KERNEL_PATH ?? path.join(repository, 'kernel/target/release', process.platform === 'win32' ? 'varin-kernel.exe' : 'varin-kernel');
const buildVersion = (JSON.parse(await readFile(path.join(repository, 'package.json'), 'utf8')) as { version: string }).version;

it('reads a connected view live and reports a missing or disconnected view with its next readable references', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'varin-ui-runtime-'));
  const client = createKernelClient({ hostId: 'ui-runtime', storageRoot: root, kernelPath, buildVersion, allowCargoDevRunner: false });
  try {
    await client.start();
    const ui = createInteractiveUiRuntime({ kernel: client, runtime: {} as never, media: {} as never });
    const family = 'thread-root';
    const saved = await ui.store.render(family, { title: 'Counter', changes: [{ op: 'write', file: 'index.html', text: '<p id="n">1</p>' }] }, 'render-1');
    const signal = new AbortController().signal;

    // No live view yet: the read explains how to obtain one instead of failing generically.
    const missing = await ui.read(family, { kind: 'ui', ref: saved.ref, view: 'state' }, signal);
    expect(missing).toMatchObject({ status: 'unavailable', code: 'ui_view_required', views: [] });
    expect(await ui.read(family, { kind: 'ui', ref: saved.ref, view: 'source', file: 'index.html' }, signal)).toMatchObject({ status: 'ready' });

    // A connected client answers the live state read through its own observation queue.
    const { viewRef, token } = await ui.attach(family, { ref: saved.ref }, undefined, 'client-a');
    const observing = ui.poll(family, viewRef, token, signal);
    await expect.poll(() => ui.read(family, { kind: 'ui', ref: saved.ref, view: 'summary' }, signal)).toMatchObject({ views: [viewRef] });
    const pending = ui.read(family, { kind: 'ui', ref: viewRef, view: 'state' }, signal);
    const request = await observing;
    expect(request).toMatchObject({ view: 'state' });
    ui.reply(family, viewRef, token, request!.id, { ref: saved.ref, viewRef, capturedAt: new Date().toISOString(),
      state: { data: { count: 2 }, controls: {}, scroll: { x: 0, y: 0 } }, viewport: { width: 300, height: 200 } });
    expect(await pending).toMatchObject({ status: 'ready', state: { data: { count: 2 } } });

    // A client without a capture surface keeps its explicit reason.
    const screen = ui.read(family, { kind: 'ui', ref: viewRef, view: 'screen' }, signal);
    const screenRequest = await ui.poll(family, viewRef, token, signal);
    ui.reply(family, viewRef, token, screenRequest!.id, { ref: saved.ref, viewRef, capturedAt: new Date().toISOString(),
      state: { data: null, controls: {}, scroll: { x: 0, y: 0 } }, viewport: { width: 300, height: 200 } });
    await expect(screen).rejects.toMatchObject({ code: 'ui_screen_capture_unsupported' });

    // After detaching, the live read is not answered from saved data and names the next references.
    await ui.detach(family, viewRef, token, { data: { count: 2 }, controls: {}, scroll: { x: 0, y: 0 } });
    expect(await ui.read(family, { kind: 'ui', ref: viewRef, view: 'state' }, signal)).toMatchObject({
      status: 'unavailable', code: 'ui_view_disconnected', source: saved.ref, savedStateAvailable: true,
      next: [{ kind: 'ui', ref: saved.ref, view: 'summary' }, { kind: 'ui', ref: saved.ref, view: 'source' }] });
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
