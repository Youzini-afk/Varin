import { expect, it, vi } from 'vitest';
import type { ApplicationExtensionRuntime } from '@varin/extension-host';
import type { RetrievalQuery } from './protocol.generated.js';
import { createRetrievalComposition, type RetrievalSemanticLease } from './retrieval-composition.js';
import type { StructureOutlineRequest, StructureClassifyRequest } from '../structure/types.js';

it('keeps fixed and materialized syntax separate from live LSP and semantic leases in the same selected configuration', async () => {
  const pin = () => ({ assertAvailable() {}, release: vi.fn(), invoke: vi.fn(async () => ({ configurationId: 'explicit', structure: 'builtin', semantic: 'builtin' })) });
  const provider = { providerId: 'selected', providerKey: 'selected-key', status: 'active' };
  const runtime = {
    routing: { read: async () => ({ authoritative: true, document: { revision: 1 } }) },
    prepareService: async () => ({ ...provider, pin }),
    services: { getSnapshot: () => ({ providers: [provider] }) },
    supervisor: { getActiveArtifactIdentity: () => 'artifact' },
  } as unknown as ApplicationExtensionRuntime;
  const syntax = {
    outline: vi.fn(async (request: StructureOutlineRequest) => ({ status: 'unsupported' as const, provider: 'tree-sitter' as const, revision: request.revision, symbols: [] })),
    classifyHits: vi.fn(async (request: StructureClassifyRequest) => ({ status: 'unsupported' as const, provider: 'tree-sitter' as const, revision: request.revision, hits: [] })),
  };
  const structure = {
    outline: vi.fn(async (request: StructureOutlineRequest) => ({ status: 'ready' as const, provider: 'lsp' as const, revision: request.revision, symbols: [] })),
    classifyHits: vi.fn(async (request: StructureClassifyRequest) => ({ status: 'ready' as const, provider: 'lsp' as const, revision: request.revision, hits: [] })),
  };
  const prepareSemantic = vi.fn(async (): Promise<RetrievalSemanticLease> => ({
    stage: { providerId: 'semantic', configurationId: 'selected-space', status: 'unavailable' },
    metadata: { bindingState: 'unavailable', providerId: 'semantic', modelId: 'model', configurationId: 'selected-space', spaceId: null,
      recipeId: null, publishedRevision: null, processEpoch: null, coverage: 'empty', lifecycle: 'idle' },
    assertAvailable() {}, async validateAvailable() {}, release() {},
  }));
  const composition = createRetrievalComposition(runtime, { structure, syntax, prepareSemantic });
  const root = { hostId: 'host', rootId: 'root', canonicalRoot: '/original/live' };
  const query: RetrievalQuery = { runId: 'run', threadId: 'thread', grantId: 'grant', projectId: null, question: 'needle',
    invocation: { kind: 'model_step', requestId: 'step', toolCallId: 'call' }, inferenceOwner: { kind: 'external', identity: 'owner', epoch: 'epoch' },
    source: { workspace_id: 'workspace', execution_workspace_id: 'execution', mode: 'fixed_branch', branch_id: 'snapshot', revision: 0, live_root: null }, physicalRoot: null };
  const scope = { threadId: 'thread', workspaceId: '/original/live' };
  const request = { path: 'file.unknown', languageId: null, text: 'snapshot body', revision: 'snapshot-revision' };
  for (const mode of ['fixed_branch', 'materialized'] as const) {
    const binding = await composition.prepare({ ...scope, query: { ...query, source: { ...query.source, mode }, physicalRoot: mode === 'materialized' ? root : null } });
    expect(binding.structure).toBe(syntax);
    expect((await binding.structure!.outline(request)).status).toBe('unsupported');
    expect(binding.plan.stages.find(stage => stage.kind === 'structure')).toMatchObject({ providerId: 'varin.kernel.tree-sitter', status: 'ready' });
    expect(binding.plan.stages.find(stage => stage.kind === 'semantic')?.status).toBe('unsupported');
    expect(binding.semantic).toBeUndefined();
    binding.release();
  }
  expect(structure.outline).not.toHaveBeenCalled();
  expect(prepareSemantic).not.toHaveBeenCalled();
  const live = await composition.prepare({ ...scope, query: { ...query, source: { workspace_id: 'workspace', execution_workspace_id: 'workspace', mode: 'live_root', branch_id: null, revision: null, live_root: root }, physicalRoot: root } });
  expect((await live.structure!.outline(request)).status).toBe('ready');
  expect(structure.outline).toHaveBeenCalledOnce();
  expect(prepareSemantic).toHaveBeenCalledOnce();
  expect(live.plan.stages.find(stage => stage.kind === 'semantic')?.status).toBe('unavailable');
  live.release();
  const fixedAgain = await composition.prepare({ ...scope, query });
  expect(fixedAgain.structure).toBe(syntax);
  expect(fixedAgain.plan.stages.find(stage => stage.kind === 'semantic')?.status).toBe('unsupported');
  expect(prepareSemantic).toHaveBeenCalledOnce();
  fixedAgain.release();
});
