import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createDocumentAuthorityHarness } from './contract-fixtures.js';
import { captureStableSourceBaseline } from '../harness/working-state/source-preparation.js';
import type { RecoveryState, WorkingStateRootStore } from '../harness/working-state/types.js';
import type { WatchCoverage, WorkspaceWatchFs } from './watch.js';

it('uses the original Documents namespace across captures while reading every current file body', async () => {
  const handles: Array<EventEmitter & { close: ReturnType<typeof vi.fn>; coverage: WatchCoverage }> = [];
  let emit: (kind: string, file: string) => void = () => undefined;
  const watchFs: WorkspaceWatchFs = { watch: vi.fn((_root, _options, listener) => {
    emit = listener;
    const handle = Object.assign(new EventEmitter(), { close: vi.fn(), coverage: { namespace: 'complete', content: 'unknown' } as WatchCoverage });
    handles.push(handle);
    return handle;
  }) };
  const harness = await createDocumentAuthorityHarness({ authority: { fsModule: watchFs } });
  const { authority: documents, workspaceRoot: directory } = harness;
  const scans: Array<readonly string[] | undefined> = [];
  let bodyReads = 0, preparation = 0;
  const scan = async (scopes?: readonly string[]) => {
    scans.push(scopes);
    const paths: string[] = [];
    const visit = async (file: string): Promise<void> => {
      const absolute = path.join(directory, file);
      const stat = await fs.promises.lstat(absolute).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!stat) return;
      if (file) paths.push(file);
      if (stat.isDirectory()) for (const name of await fs.promises.readdir(absolute)) {
        if (name !== '.git' && name !== '.varin') await visit(file ? `${file}/${name}` : name);
      }
    };
    for (const scope of scopes ?? ['']) await visit(scope);
    return paths.sort();
  };
  const store = {
    readSourcePreparation: async () => null,
    listWorkspaceBaselinePaths: async () => scan(),
    listCaptureScopePaths: async (_directory: string, scopes: readonly string[]) => scan(scopes),
    captureDirectory: async (_directory: string, paths: readonly string[]) => {
      const states: Record<string, RecoveryState> = {};
      for (const file of paths) {
        const absolute = path.join(directory, file);
        const stat = await fs.promises.lstat(absolute);
        if (stat.isDirectory()) states[file] = { kind: 'directory', mode: stat.mode & 0o7777 };
        else {
          const bytes = await fs.promises.readFile(absolute); bodyReads += 1;
          states[file] = { kind: 'regular-file', objectHash: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length, mode: stat.mode & 0o7777 };
        }
      }
      return states;
    },
    releaseCapturedStates: async () => undefined,
    createBranch: async (_workspace: string, branchId: string, states: Record<string, RecoveryState>) => ({ branchId, states }),
  } as unknown as WorkingStateRootStore;
  const prepare = () => captureStableSourceBaseline({ store, directory, workspaceId: harness.identity.workspaceId,
    captureWorkspaceId: harness.identity.workspaceId, branchId: `capture-${++preparation}`, captureScopes: [], content: { mode: 'saved-files' } },
  { documents, inspectInventory: async () => ({ kind: 'directory' }) });
  try {
    await fs.promises.mkdir(path.join(directory, 'docs'));
    await fs.promises.mkdir(path.join(directory, 'other'));
    await fs.promises.writeFile(path.join(directory, 'docs/a'), 'one');
    await fs.promises.writeFile(path.join(directory, 'other/b'), 'two');
    await prepare();
    expect(scans).toEqual([undefined]);
    expect(bodyReads).toBe(4);
    expect(handles[0]!.close).not.toHaveBeenCalled();
    await prepare();
    expect(scans).toEqual([undefined]);
    expect(bodyReads).toBe(8);
    expect(handles).toHaveLength(1);

    await fs.promises.writeFile(path.join(directory, 'docs/a'), 'changed without namespace proof');
    emit('content', 'docs/a');
    const changed = await prepare();
    expect(bodyReads).toBe(12);
    expect(scans).toEqual([undefined]);
    expect((changed.branch as unknown as { states: Record<string, RecoveryState> }).states['docs/a']).toMatchObject({
      objectHash: createHash('sha256').update('changed without namespace proof').digest('hex'),
    });

    await fs.promises.writeFile(path.join(directory, 'docs/new'), 'new');
    emit('rename', 'docs/new');
    const added = await prepare();
    expect(scans).toEqual([undefined, ['docs/new']]);
    expect(Object.keys((added.branch as unknown as { states: object }).states)).toContain('docs/new');
    await fs.promises.rm(path.join(directory, 'docs'), { recursive: true });
    emit('rename', 'docs');
    const removed = await prepare();
    expect(scans.at(-1)).toEqual(['docs']);
    expect(Object.keys((removed.branch as unknown as { states: object }).states)).toEqual(['.', 'other', 'other/b']);

    // A lost observation generation discards the old namespace, even if the
    // restarted port later advertises complete coverage again.
    documents.emitWatchOverflow(harness.identity.workspaceId);
    await prepare();
    expect(scans.filter(value => value === undefined)).toHaveLength(2);
    handles[0]!.coverage = { namespace: 'unknown', content: 'unknown' };
    await prepare();
    expect(scans.filter(value => value === undefined)).toHaveLength(4);
    expect(handles[0]!.close).toHaveBeenCalledOnce();
  } finally { await harness.cleanup(); }
});
