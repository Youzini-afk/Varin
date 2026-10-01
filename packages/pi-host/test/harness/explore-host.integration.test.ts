import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { HarnessActorContext, AgentInputContext } from '@varin/protocol';
import { createExploreTool } from '../../src/harness/explore-tool.js';
import type { HostServicesBridge } from '../../src/harness/host-services-bridge.js';
import { createExploreQueryStore } from '../../../web/application-host/lib/harness/explore-query-store.js';
import { createOutputStore } from '../../../web/application-host/lib/harness/output-store.js';
import type { HarnessServiceHost } from '../../../web/application-host/lib/harness/service-host.js';
import type { HarnessServiceContext } from '../../../web/application-host/lib/harness/router.js';
import { createExploreQueryStartService, createExploreQueryPlanService, createExploreQueryViewsService as collectService,
  createExploreQueryWaitService, createExploreQuerySelectService, createExploreQueryFollowupService,
  createExploreQueryFinishService, createExploreQueryReleaseService } from '../../../web/application-host/lib/harness/explore-query-services.js';
const actor: HarnessActorContext = { authorityInstanceId: 'test', sessionId: 'test', workerId: 'worker', workerGeneration: 1,
  workspaceId: 'workspace', grantedCapabilities: ['read.search'] };
const context = (inputContext: AgentInputContext): HarnessServiceContext => ({ actor, sessionId: actor.sessionId,
  workspaceId: actor.workspaceId, authorizedPaths: [], inputContext, signal: new AbortController().signal });

for (let configuration = 0; configuration < 16; configuration++) it(`executes optional capability combination ${configuration} through the public tool and shared Host`, async () => {
    const llm = Boolean(configuration & 1);
    const decision = Boolean(configuration & 2);
    const embedding = Boolean(configuration & 4);
    const rerank = Boolean(configuration & 8);
    const decisionQuestions: string[] = [];
    let generations = 0;
    let rankings = 0, embeddings = 0;
    const ranking = async (input: { documents: { id: string }[] }) => { rankings++; return { batchId: 'test', scores: input.documents.map((doc, index) => ({ id: doc.id, index, score: 1 })) }; };
    const semantic = async () => { embeddings++; return { status: 'ready', coverage: 'complete', lifecycle: 'ready', hits: [] }; };
    const store = createExploreQueryStore();
    const outputs = createOutputStore();
    const host = {
      exploreQueryStore: store, outputStore: outputs,
      searchService: { search: async () => ({ status: 'ready', files: [{ path: 'a.ts', hits: [{ line: 1, text: 'needle' }] }], partial: false }) },
      readExploreFile: async () => ({ status: 'ready', content: configuration === 2
        ? 'needle\ncontext\ncontext\ncontext\nfollowup evidence\nend' : 'needle', revision: 'r1', source: 'disk' }),
      ...(embedding ? { semanticRecall: semantic } : {}),
      harnessSettings: async () => ({ global: { harness: rerank ? { rerank: { protocol: 'http-rerank', providerId: 'rank', modelId: 'model' } } : {} } }),
      rerankExploreViews: ranking,
      fastDecisionStatus: async () => decision ? { status: 'ready', binding: { protocol: 'typesafe-systemone', providerId: 'decision', modelId: 'test', configurationId: 'fixed' } } : { status: 'unconfigured' },
      fastDecision: async (input: { questions: { id: string }[] }) => {
        // A real provider responds after the initial reads have settled. The
        // public tool must still let its selected operation run before finish.
        await new Promise<void>(resolve => setImmediate(resolve));
        decisionQuestions.push(...input.questions.map(question => question.id));
        return { answers: input.questions.map(question => ({ id: question.id, kind: 'judge',
          value: question.id.startsWith('m:') || configuration === 2 && question.id === 'a:read:a.ts:5-6' ? 1 : 0 })), missing: [] };
      },
    } as unknown as HarnessServiceHost;
    const services = {
      'explore.query.start': createExploreQueryStartService(host),
      'explore.query.plan': createExploreQueryPlanService(host),
      'explore.query.views': collectService(host),
      'explore.query.wait': createExploreQueryWaitService(host),
      'explore.query.select': createExploreQuerySelectService(host),
      'explore.query.followup': createExploreQueryFollowupService(host),
      'explore.query.finish': createExploreQueryFinishService(host),
      'explore.query.release': createExploreQueryReleaseService(host),
    };
    const bridge = { inputContext: () => ({ source: 'disk' }), cancel: () => undefined,
      request: async (method: keyof typeof services, params: never) => services[method].handle(params, context({ source: 'disk' })),
    } as unknown as HostServicesBridge;
    const tool = createExploreTool(bridge, actor.sessionId, llm ? { complete: async ({ user }) => {
      generations++;
      const viewId = /view (v\d+) /.exec(user)?.[1];
      return JSON.stringify({ groups: viewId ? [{ id: 'answer', purpose: 'source', views: [{ viewId }] }] : [], done: Boolean(viewId) });
    } } : undefined);
    try {
      const result = await tool.execute('test', { question: 'needle' }, undefined, undefined, undefined as never);
      assert.notEqual((result as { isError?: boolean }).isError, true);
      assert.ok(result.content.some(part => part.type === 'text' && part.text.includes('needle')));
      if (configuration === 2) assert.ok(result.content.some(part => part.type === 'text' && part.text.includes('followup evidence')));
      assert.equal(generations > 0, llm);
      assert.equal(decisionQuestions.some(id => id.startsWith('m:')), decision && !llm);
      assert.equal(rankings > 0, rerank && !llm && !decision);
      assert.equal(embeddings > 0, embedding);
    } finally { store.dispose(); outputs.dispose(); }
  });
