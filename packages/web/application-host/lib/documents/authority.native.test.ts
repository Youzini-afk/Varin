import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDocumentAuthorityHarness, type DocumentAuthorityHarness } from './contract-fixtures.js';
import type { WatchEvent, WatchPosition } from './watch.js';
import { createNativeProcessTestHarness } from '../process/native-process.test-helper.js';

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const waitUntil = async <T>(probe: () => T | Promise<T>, timeoutMs = 8000): Promise<T> => {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await wait(20);
  }
  throw lastError ?? new Error('Timed out waiting for document authority condition');
};

const isWatchEvent = (value: unknown): value is WatchEvent => (
  Boolean(value)
  && typeof value === 'object'
  && !Array.isArray(value)
  && typeof (value as { kind?: unknown }).kind === 'string'
  && typeof (value as { sourceId?: unknown }).sourceId === 'string'
  && Number.isSafeInteger((value as { generation?: unknown }).generation)
  && Number.isSafeInteger((value as { sequence?: unknown }).sequence)
);

describe('document authority native observation', () => {
  let harness!: DocumentAuthorityHarness;
  beforeEach(async () => { harness = await createDocumentAuthorityHarness(); });
  afterEach(async () => { await harness?.cleanup(); });

  it('watches created, changed, moved, deleted, and reset events without file bodies', async () => {
    const events: WatchEvent[] = [];
    const subscription = harness.authority.watch(harness.identity.workspaceId, (event: unknown) => {
      if (!isWatchEvent(event)) return;
      events.push(event);
    });
    await waitUntil(() => harness.authority.hasWatch(harness.identity.workspaceId));
    await wait(150);
    const filePath = path.join(harness.workspaceRoot, 'watched.txt');
    await fs.promises.writeFile(filePath, 'one');
    await waitUntil(() => events.some((event) => event.kind === 'created' && event.resource?.resourceId === 'watched.txt'));
    await fs.promises.writeFile(filePath, 'two');
    await waitUntil(() => events.some((event) => event.kind === 'changed' && event.resource?.resourceId === 'watched.txt'));
    await fs.promises.rename(filePath, path.join(harness.workspaceRoot, 'renamed.txt'));
    await waitUntil(() => events.some((event) => (
      event.kind === 'moved'
      || (event.kind === 'deleted' && event.resource?.resourceId === 'watched.txt')
    )));
    await fs.promises.unlink(path.join(harness.workspaceRoot, 'renamed.txt'));
    await waitUntil(() => events.some((event) => event.kind === 'deleted'));
    expect(JSON.stringify(events)).not.toContain('one');
    expect(JSON.stringify(events)).not.toContain('two');
    expect(harness.authority.emitWatchOverflow(harness.identity.workspaceId)).toBe(true);
    await waitUntil(() => events.some((event) => event.kind === 'reset' && event.reason === 'overflow'));
    harness.authority.reconnectWatch(harness.identity.workspaceId);
    await waitUntil(() => events.some((event) => event.kind === 'reset' && event.reason === 'reconnected'));
    const overflowIndex = events.findIndex((event) => event.kind === 'reset' && event.reason === 'overflow');
    expect(events.slice(overflowIndex).filter((event) => event.kind === 'deleted')).toEqual([]);
    subscription.close();
  });

});

it('uses a fresh watch source as the baseline after each watcher rebuild', async () => {
  const harness = await createDocumentAuthorityHarness();
  try {
    const firstCapture = await harness.authority.beginCapture(harness.identity.workspaceId);
    const firstResult = await harness.authority.completeCapture(firstCapture);
    expect(firstResult.stable).toBe(true);

    await fs.promises.writeFile(path.join(harness.workspaceRoot, 'between-captures.txt'), 'fresh source');
    const secondCapture = await harness.authority.beginCapture(harness.identity.workspaceId);
    const secondResult = await harness.authority.completeCapture(secondCapture);
    expect(secondResult.stable).toBe(true);
    const firstWatch = firstCapture.watch as WatchPosition | null;
    const secondWatch = secondCapture.watch as WatchPosition | null;
    const resultWatch = secondResult.state.watch as WatchPosition | null;
    if (!firstWatch || !secondWatch || !resultWatch) throw new Error('Expected capture watch positions');
    expect(secondWatch.sourceId).not.toBe(firstWatch.sourceId);
    expect(resultWatch.sourceId).toBe(secondWatch.sourceId);
  } finally {
    await harness.cleanup();
  }
});

it('allows only an explicit restore capture to validate under maintenance', async () => {
  const harness = await createDocumentAuthorityHarness();
  try {
    await harness.authority.setMaintenance(harness.identity.workspaceId, true);
    const ordinary = await harness.authority.beginCapture(harness.identity.workspaceId);
    expect(await harness.authority.completeCapture(ordinary)).toMatchObject({
      stable: false,
      reasons: expect.arrayContaining(['maintenance']),
    });
    const restore = await harness.authority.beginCapture(harness.identity.workspaceId, {
      allowMaintenance: true,
    });
    expect(await harness.authority.completeCapture(restore)).toMatchObject({ stable: true, reasons: [] });
    await harness.authority.setMaintenance(harness.identity.workspaceId, false);
  } finally {
    await harness.cleanup();
  }
});

it('excludes the dispatching round admission without ignoring real writer activity during capture', async () => {
  const harness = await createDocumentAuthorityHarness();
  const round = await harness.authority.registerWriter(harness.token(), { purpose: 'pi-agent-run:agent.prompt' });
  try {
    const options = { ignoredWriterIds: [round.writerId] };
    const quiet = await harness.authority.beginCapture(harness.identity.workspaceId, options);
    expect(await harness.authority.completeCapture(quiet)).toMatchObject({ stable: true });
    const capture = await harness.authority.beginCapture(harness.identity.workspaceId, options);
    const observations: Promise<unknown>[] = [];
    const unsubscribe = harness.authority.subscribeMutationState(workspaceId => {
      observations.push(harness.authority.inspectMutation(workspaceId));
    });
    const writer = await harness.authority.registerWriter(harness.token(), { purpose: 'documents-write' });
    await writer.close();
    unsubscribe();
    const states = await Promise.all(observations);
    expect(states.at(-1)).toMatchObject({ activeWriters: [{ writerId: round.writerId }] });
    expect(states.length).toBeGreaterThanOrEqual(2);
    expect(await harness.authority.completeCapture(capture)).toMatchObject({
      stable: false, reasons: expect.arrayContaining(['writer-activity']),
    });
  } finally {
    await round.close();
    await harness.cleanup();
  }
});

it('drains fixture-owned Documents watches before the original kernel exits', async () => {
  const native = createNativeProcessTestHarness();
  const f = await native.get();
  let unsubscribe = () => {};
  try {
    const directory = path.join(f.root, 'watched-workspace');
    await fs.promises.mkdir(directory);
    const { workspaceId } = await f.documents.resolveWorkspace({ path: directory });
    const subscription = f.documents.watch(workspaceId, () => {});
    expect(await subscription.ready).toBe(true);
    await subscription.settle();
    expect(f.documents.hasWatch(workspaceId)).toBe(true);
    let watchAtKernelExit: boolean | undefined;
    unsubscribe = f.client.subscribeExit(() => { watchAtKernelExit = f.documents.hasWatch(workspaceId); });
    // Do not close the subscription in the test: its original fixture owner
    // must do so before kernel shutdown, and then remove the actual directory.
    await native.dispose();
    expect(watchAtKernelExit).toBe(false);
    expect(fs.existsSync(f.root)).toBe(false);
  } finally {
    unsubscribe();
    await native.dispose();
  }
});
