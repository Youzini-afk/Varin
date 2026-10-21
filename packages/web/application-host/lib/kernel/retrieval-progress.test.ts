import { expect, it, vi } from 'vitest';
import { createRetrievalOwner } from './retrieval-owner.js';
import { RetrievalBridge } from './retrieval-bridge.js';
import { createRetrievalPipelineOwner, type RetrievalModel } from '../harness/retrieval-pipeline.js';
import type { RetrievalSourceOwner } from './retrieval-source.js';
import type { KernelClient } from './kernel-client.js';
import type { RetrievalQuery } from './protocol.generated.js';

it.each([false, true])('publishes evidence and can finish it while model work is still draining (finish=%s)', async finish => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const select = vi.fn<Extract<RetrievalModel, { kind: 'progressive' }>['select']>(async ({ run, progress }) => {
    await run.waitForViews();
    progress?.phase('selecting');
    await gate;
    if (!run.deliveryReason()) run.applySelection([{ id: 'selected-frame', purpose: 'direct evidence',
      views: run.collect().views.map(view => ({ viewId: view.viewId, required: false })),
    }]);
    return {};
  });
  const pipelines = createRetrievalPipelineOwner({ configurationId: 'test', model: {
    providerId: 'selected', configurationId: 'selected', status: 'ready', implementation: { kind: 'progressive', select },
  } });
  const sources = { validate: async () => {}, checkPath: async () => {}, pathScopes: async () => [''],
    read: async () => ({ status: 'ready', content: 'export const frameSize = 42;', revision: 'revision', source: 'disk' }),
    compute: async () => ({ status: 'ready', records: [{ kind: 'hit', path: 'src/frames.ts', revision: 'revision',
      data: { line: 1, column: 14, preview: 'export const frameSize = 42;', before: [], after: [] } }] }),
  } as unknown as RetrievalSourceOwner;
  const query: RetrievalQuery = { runId: 'run', threadId: 'thread', grantId: 'grant', projectId: null, question: 'frameSize',
    invocation: { kind: 'model_step', requestId: 'request', toolCallId: 'call' }, inferenceOwner: { kind: 'external', identity: 'owner', epoch: 'epoch' },
    source: { resource_owner: { kind: 'local' }, workspace_id: 'workspace', execution_workspace_id: 'workspace', mode: 'fixed_branch', branch_id: 'branch', revision: 0, live_root: null }, physicalRoot: null };
  const send = vi.fn(async (_frame: unknown) => {});
  const failed = vi.fn();
  const bridge = new RetrievalBridge(() => 'epoch', send, failed);
  bridge.setOwner(createRetrievalOwner({ sources, pipelines, kernel: {} as KernelClient }));
  try {
    bridge.consume({ v: 1, kind: 'retrieval-request', id: 'query', kernelEpoch: 'epoch', query });
    await expect.poll(() => send.mock.calls.map(([frame]) => frame)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'retrieval-progress', progress: expect.objectContaining({ phase: 'selecting', receivedFiles: 1,
        activities: expect.arrayContaining([expect.objectContaining({ kind: 'read', path: 'src/frames.ts' })]) }) }),
    ]));
    expect(send.mock.calls.some(([frame]) => (frame as { kind: string }).kind === 'retrieval-response')).toBe(false);
    expect(JSON.stringify(send.mock.calls)).not.toContain('export const');
    if (finish) bridge.consume({ v: 1, kind: 'retrieval-finish', id: 'query', kernelEpoch: 'epoch' });
    else release();
    await expect.poll(() => send.mock.calls.at(-1)?.[0]).toMatchObject({ kind: 'retrieval-response', result: {
      snippets: [expect.objectContaining({ path: 'src/frames.ts', content: '' })],
    } });
    expect((send.mock.calls.at(-1)?.[0] as { result: object }).result).not.toHaveProperty('progress');
    expect(send.mock.calls.at(-1)?.[0]).toMatchObject({ result: { completion: { reason: finish ? 'user' : 'sources-exhausted' } } });
    expect(select).toHaveBeenCalledOnce();
    expect(failed).not.toHaveBeenCalled();
  } finally { release(); bridge.close(); }
});
