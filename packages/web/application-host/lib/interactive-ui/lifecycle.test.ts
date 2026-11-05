import { expect, it, vi } from 'vitest';
import { createUiActivity, releaseUiRecords } from './lifecycle.js';
import type { KernelRecordResult, MaterialRetention } from '../kernel/protocol.generated.js';
import type { KernelScopedClient } from '../kernel/kernel-client.js';
const workspaceId = '__varin_ui__:parent';
const row = (recordId: string, recordType: string, value: unknown): KernelRecordResult => ({ recordId, recordType,
  workspaceId, state: 'active', payloadJson: JSON.stringify(value), recordRevision: 1, references: [], createdAt: 1, updatedAt: 1 });
const plan = (uiReferences: string[] = []): MaterialRetention => ({ uiReferences, threads: [{ threadId: 'parent', rootThreadId: 'parent', release: true }],
  sources: [], attachments: [], inheritances: [], attachmentPreparations: [], attachmentSources: [] });
function fixture(records: KernelRecordResult[], pageSize = 2) {
  const rows = [...records], released: string[] = [];
  const client = { listRecords: vi.fn(async ({ cursor = 0 }: { cursor?: number }) => ({ records: rows.slice(cursor, cursor + pageSize), nextCursor: cursor + pageSize < rows.length ? cursor + pageSize : null })),
    releaseRecord: vi.fn(async (_operation: string, _workspace: string, id: string) => { released.push(id); rows.splice(rows.findIndex(row => row.recordId === id), 1); return { released: true }; }) };
  return { client: client as unknown as KernelScopedClient, released, rows };
}
it('releases a deleted family through all pages while preserving surviving selection, snapshot and embedded work dependencies', async () => {
  const f = fixture([
    row('ui:shared', 'ui.work', { versions: [{ ref: 'ui:shared@1', content: { type: 'embed', ref: 'ui:nested@2' } }] }),
    row('ui:nested', 'ui.work', { versions: [{ ref: 'ui:nested@2' }] }),
    row('ui-snapshot:kept', 'ui.snapshot', { ref: 'ui:shared@1', viewRef: 'ui-view:old', state: { data: 'frozen' } }),
    row('ui-selection:kept', 'ui.selection', { snapshotRef: 'ui-snapshot:kept' }),
    row('ui-view:old', 'ui.view', { source: { ref: 'ui:unrelated@1' }, state: { data: 'later view' } }),
    row('ui:unrelated', 'ui.work', { versions: [{ ref: 'ui:unrelated@1' }] }),
    row('ui-snapshot:preview', 'ui.snapshot', { preview: { contents: { 'index.html': 'unfinished' } } }),
    row('ui-selection:abandoned', 'ui.selection', { snapshotRef: 'ui-snapshot:preview' }),
    row('ui-branch-state:old', 'ui.snapshot', { kind: 'branch-state', target: { threadId: 'parent', branchId: 'fork' }, views: [] }),
    row('another-domain', 'agent.personalization', { notes: 'untouched' }),
  ]);
  expect(await releaseUiRecords(f.client, workspaceId, plan(['ui-selection:kept']))).toEqual({ released: 5 });
  expect(f.released).toEqual(['ui-view:old', 'ui:unrelated', 'ui-snapshot:preview', 'ui-selection:abandoned', 'ui-branch-state:old']);
  expect(f.rows.map(row => row.recordId)).toEqual(['ui:shared', 'ui:nested', 'ui-snapshot:kept', 'ui-selection:kept', 'another-domain']);
  expect(await releaseUiRecords(f.client, workspaceId, plan())).toEqual({ released: 4 });
  expect(f.rows.map(row => row.recordId)).toEqual(['another-domain']);
});
it('keeps the original family access lifetime, including drafts, until every family executor is retired', async () => {
  const f = fixture([row('ui:unmentioned', 'ui.work', { versions: [] }), row('ui-selection:draft', 'ui.selection', { snapshotRef: 'ui-snapshot:draft' })]);
  const current = plan(); current.threads.push({ threadId: 'child', rootThreadId: 'parent', release: false });
  await releaseUiRecords(f.client, workspaceId, current);
  expect(f.released).toEqual([]);
  current.threads[1]!.release = true;
  await releaseUiRecords(f.client, workspaceId, current);
  expect(f.released).toEqual(['ui:unmentioned', 'ui-selection:draft']);
});
it('fails closed on missing native roots, unknown families or malformed stored assets', async () => {
  const f = fixture([{ ...row('ui:unknown', 'ui.work', {}), payloadJson: '{invalid' }, row('ui:valid', 'ui.work', { versions: [] })]);
  await expect(releaseUiRecords(f.client, workspaceId, { ...plan(), uiReferences: undefined } as unknown as MaterialRetention)).rejects.toThrow('retention roots');
  const valid = fixture([row('ui:valid', 'ui.work', { versions: [] })]);
  await releaseUiRecords(valid.client, workspaceId, { ...plan(), threads: [] });
  expect(valid.released).toEqual([]);
  await expect(releaseUiRecords(f.client, workspaceId, plan())).rejects.toThrow('malformed');
  expect(f.released).toEqual([]);
});
it('drains actual read/write completion, queues new activity, and resumes after cleanup failure', async () => {
  const activity = createUiActivity(), events: string[] = [];
  let finish!: () => void, release!: () => void;
  const active = activity.run('family', async () => { events.push('read'); await new Promise<void>(resolve => { finish = resolve; }); events.push('read complete'); });
  const collection = activity.exclusive('family', async () => { events.push('collect'); await new Promise<void>(resolve => { release = resolve; }); throw new Error('storage failure'); });
  const caught = expect(collection).rejects.toThrow('storage failure');
  const later = activity.run('family', async () => { events.push('later'); });
  const unrelated = activity.run('other-family', async () => { events.push('other'); });
  await unrelated; expect(events).toEqual(['read', 'other']);
  finish(); await active; await Promise.resolve(); expect(events).toEqual(['read', 'other', 'read complete', 'collect']);
  release(); await caught; await later; expect(events.at(-1)).toBe('later');
});
