import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runtimeFetch } from '@varin/application-client';
import type { ThreadIdentity, ThreadMaterialsAPI, ThreadResearchAPI, ThreadResearchScope, ThreadResearchSelection } from '@varin/application-client';
import type { ExperimentAttemptView } from '@varin/protocol';
import { ThreadResearch } from '@/components/thread/ThreadResearch';
import { loadResearchArtifact } from './researchFacts';
import type { VarinEvent } from '@/lib/varinEvents';

const mocks = vi.hoisted(() => ({
  translate: (key: string, params?: Record<string, unknown>) => (
    params ? `${key}:${JSON.stringify(params)}` : key
  ),
  listeners: new Set<(event: VarinEvent) => void>(),
}));
vi.mock('@varin/application-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@varin/application-client')>()),
  runtimeFetch: vi.fn(),
}));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: mocks.translate }) }));
vi.mock('@/lib/varinEvents', () => ({
  subscribeVarinEvents: (listener: (event: VarinEvent) => void) => {
    mocks.listeners.add(listener);
    return () => { mocks.listeners.delete(listener); };
  },
}));

const materials: ThreadMaterialsAPI = { read: vi.fn(), readSource: vi.fn(), readArtifact: vi.fn() };

const attempt = {
  attemptId: 'attempt-1',
  specId: 'spec-1',
  cancelRequested: false,
  backend: 'local',
  machineId: 'local',
  state: 'running',
  collection: 'none',
  createdAt: 1,
};

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  const dom = parseHTML('<!doctype html><html><body></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('HTMLElement', dom.HTMLElement);
  vi.stubGlobal('Node', dom.Node);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.listeners.clear();
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('ResearchFactsPanel', () => {
  it('uses native scopes and preserves the original rerun intent after an uncertain response', async () => {
    const identity: ThreadIdentity = { runtime: 'agent', threadId: 'thread:research', branchId: 'branch:research' };
    const scopes: ThreadResearchScope[] = ['old-source', 'new-source'].map(sourceRunId => ({ sourceRunId,
      workspaceId: `workspace:${sourceRunId}`, executionWorkspaceId: `workspace:${sourceRunId}`, canSubmit: true,
      source: { workspace_id: `workspace:${sourceRunId}`, execution_workspace_id: `workspace:${sourceRunId}`,
        branch_id: `source:${sourceRunId}`, revision: 0, mode: 'fixed_branch', live_root: null, resource_owner: { kind: 'local' } },
    }));
    const original = { ...attempt, state: 'failed', permissions: { control: true } } as ExperimentAttemptView;
    let attempts = [original];
    const accepted = { ...original, attemptId: 'attempt:rerun', state: 'submitted', specId: null } as ExperimentAttemptView;
    let lost = true;
    const api = {
      scopes: vi.fn(async () => scopes), list: vi.fn(async (_selection: ThreadResearchSelection) => ({ attempts, text: '' })),
      resources: vi.fn(async () => ({ machines: [], generatedAt: 1, text: '' })),
      sources: vi.fn(async () => ({ sources: [], text: '' })),
      submit: vi.fn(async (_selection, request) => {
        if (lost) { lost = false; throw new Error('acceptance response lost'); }
        const receipt = { ...accepted, requestId: request.requestId, retryOfAttemptId: request.retryOfAttemptId };
        attempts = [original, receipt];
        return { attempt: receipt, spec: null, text: 'accepted' };
      }), get: vi.fn(), logs: vi.fn(), artifact: vi.fn(), cancel: vi.fn(), collect: vi.fn(),
    } satisfies ThreadResearchAPI;
    await act(async () => root.render(<ThreadResearch api={api} materials={materials} identity={identity} sourceRunId="old-source" />));
    expect(container.textContent).toContain('attempt-1');
    const rerun = () => [...container.querySelectorAll('button')].find(button => button.textContent === 'research-facts.rerun')!;
    await act(async () => rerun().click());
    expect(container.textContent).toContain('acceptance response lost');
    await act(async () => rerun().click());
    expect(api.submit.mock.calls).toHaveLength(2);
    expect(api.submit.mock.calls[1]).toEqual(api.submit.mock.calls[0]);
    expect(api.submit.mock.calls[0]![0]).toEqual({ ...identity, sourceRunId: 'old-source' });
    expect(container.textContent).toContain('attempt:rerun');
    // A successor Run changed its source. The displayed historical research scope remains selected.
    await act(async () => root.render(<ThreadResearch api={api} materials={materials} identity={identity} sourceRunId="new-source" />));
    expect(api.list.mock.calls.at(-1)?.[0].sourceRunId).toBe('old-source');
    expect(container.querySelectorAll('option')).toHaveLength(2);
    expect(vi.mocked(runtimeFetch)).not.toHaveBeenCalled();
  });

  it('keeps native read-only facts visible and pages original artifact bytes without a Pi session', async () => {
    const identity: ThreadIdentity = { runtime: 'agent', threadId: 'thread:reader', branchId: 'branch:reader' };
    const selection = { ...identity, sourceRunId: 'read-source' };
    const api = {
      scopes: vi.fn(async () => [{ sourceRunId: selection.sourceRunId, workspaceId: 'workspace:reader', executionWorkspaceId: 'workspace:reader', canSubmit: false,
        source: { workspace_id: 'workspace:reader', execution_workspace_id: 'workspace:reader', branch_id: 'source:reader', revision: 0, mode: 'fixed_branch' as const, live_root: null, resource_owner: { kind: 'local' as const } } }]),
      list: vi.fn(async () => ({ attempts: [
        { ...attempt, permissions: { control: false } } as ExperimentAttemptView,
        { ...attempt, attemptId: 'attempt:old-branch', state: 'failed', permissions: { control: true } } as ExperimentAttemptView,
      ], text: '' })),
      resources: vi.fn(async () => ({ machines: [], generatedAt: 1, text: '' })), sources: vi.fn(async () => ({ sources: [], text: '' })),
      artifact: vi.fn(async (_selection, request) => ({ attemptId: request.attemptId, artifactId: request.artifactId,
        name: 'original.bin', offset: request.offset ?? 0, nextOffset: request.offset === 2 ? 4 : 2,
        eof: request.offset === 2, bytesBase64: request.offset === 2 ? 'AP8=' : 'QUI=', text: null })),
      get: vi.fn(), logs: vi.fn(), cancel: vi.fn(), collect: vi.fn(), submit: vi.fn(),
    } satisfies ThreadResearchAPI;
    await act(async () => root.render(<ThreadResearch api={api} materials={materials} identity={identity} sourceRunId={selection.sourceRunId} />));
    expect(container.textContent).toContain('attempt-1');
    expect([...container.querySelectorAll('button')].some(button => button.textContent === 'research-facts.cancel')).toBe(false);
    expect([...container.querySelectorAll('button')].some(button => button.textContent === 'research-facts.rerun')).toBe(false);
    const blob = await loadResearchArtifact({ api, materials, selection, canSubmit: false }, 'attempt-1', 'artifact:binary');
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([65, 66, 0, 255]);
    expect(api.artifact.mock.calls.map(([, request]) => request.offset)).toEqual([0, 2]);
    expect(vi.mocked(runtimeFetch)).not.toHaveBeenCalled();
  });

});
