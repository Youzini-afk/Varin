import { describe, expect, it } from 'vitest';
import { createExploreQueryRun, formatExploreOutput } from './explore.js';

const ready = (content: string) => ({ status: 'ready' as const, content, revision: 'r1', source: 'disk' as const });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

describe('incremental Explore evidence and delivery', () => {
  it('exposes read evidence while optional structure and another recall source are still blocked', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const run = createExploreQueryRun({ question: 'needle', limit: 1 }, {
      rgSearch: async () => Array.from({ length: 30 }, (_, i) => ({ path: `f${i}.ts`, line: 1, text: 'needle' })),
      readFile: async () => ready('needle\nnext();'),
      structure: { outline: async request => {
        expect(request.warmOnly).toBe(true);
        await blocked;
        return { status: 'unsupported', provider: null, revision: request.revision, symbols: [] };
      }, classifyHits: async request => ({ status: 'unsupported', provider: null, revision: request.revision, hits: [] }) },
      semantic: { search: async () => { await blocked; return { status: 'unavailable', coverage: 'empty', lifecycle: 'idle', hits: [] }; } },
    });
    try {
      run.start();
      await tick();
      const batch = run.collect();
      expect(batch.pending).toBe(true);
      expect(new Set(batch.views.map(view => view.path)).size).toBe(30);
      expect(run.finish().snippets).toHaveLength(1);
      release();
      await tick();
      expect(run.finish().snippets).toHaveLength(1); // late completion cannot mutate delivery
    } finally { release(); run.cancel(); }
  });

  it('does not lose progress between collect and wait, and detaches a cancelled waiter', async () => {
    const run = createExploreQueryRun({ question: 'needle' }, {
      rgSearch: async () => [{ path: 'a.ts', line: 1, text: 'needle' }], readFile: async () => ready('needle'),
    });
    const first = run.collect();
    run.start();
    await run.waitForViews();
    await run.waitForProgress(first.sequence);
    const waiter = new AbortController();
    const waiting = run.waitForProgress(run.collect().sequence, waiter.signal);
    waiter.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    run.cancel();
  });

  it('pages real seen ranges, rejects unoffered identities, and keeps basic actions without a graph', async () => {
    const run = createExploreQueryRun({ question: 'needle' }, {
      rgSearch: async () => ['a.ts', 'b.ts'].map(path => ({ path, line: 1, text: 'needle' })),
      readFile: async () => ready('needle\nresolveTarget();'),
    });
    await run.waitForViews();
    const first = run.collect({ inputBytes: 1 });
    expect(first.views).toHaveLength(1);
    expect(first.unevaluated).toBeGreaterThan(0);
    expect(run.applySelection([{ id: 'bad', purpose: 'fabricated', views: [{ viewId: 'not-offered' }] }]).rejected).toHaveLength(1);
    const next = run.collect({ seen: first.views.map(view => view.viewId), inputBytes: 1 });
    expect(next.views[0]?.viewId).not.toBe(first.views[0]?.viewId);
    const actions = await run.actionCandidates();
    expect(actions.some(action => action.kind === 'symbol' && action.target === 'resolveTarget')).toBe(true);
    run.cancel();
  });

  it('keeps a required evidence group atomic under the actual visible budget', async () => {
    const body = (path: string) => `needle ${path} ${'x'.repeat(500)}`;
    const run = createExploreQueryRun({ question: 'needle' }, {
      rgSearch: async () => ['a.ts', 'b.ts'].map(path => ({ path, line: 1, text: body(path) })),
      readFile: async path => ready(body(path)),
    });
    await run.waitForViews();
    const views = run.collect().views;
    run.applySelection([{ id: 'cause-and-effect', purpose: 'both required', views: views.map(view => ({ viewId: view.viewId })) }]);
    const result = run.finish();
    expect(result.snippets).toHaveLength(2);
    const packed = formatExploreOutput(result, { byteBudget: 1000, handle: 'out_test', prefix: 'scope: test' });
    expect(packed.snippets).toEqual([]);
    expect(packed.visibleText).not.toContain('--- a.ts');
    expect(packed.visibleText).not.toContain('--- b.ts');
    expect(packed.omitted.filter(item => item.reason.includes('required'))).toHaveLength(2);
    expect(Buffer.byteLength(packed.visibleText)).toBeLessThanOrEqual(1000);
  });

  it('honors an explicit empty model selection instead of returning rejected source hits', async () => {
    const run = createExploreQueryRun({ question: 'needle' }, {
      rgSearch: async () => [{ path: 'a.ts', line: 1, text: 'needle' }], readFile: async () => ready('needle'),
    });
    await run.waitForViews();
    run.collect();
    run.applySelection([]);
    expect(run.finish().snippets).toEqual([]);
  });
});
