import { expect, it } from 'vitest';
import { ContextPreparationTiming } from './context-timing.js';
it('keeps unknown observations distinct and fences configuration, branch and checkpoint changes', () => {
  let at = 0;
  const samples = new ContextPreparationTiming(() => at);
  const observe = (branch: string, identity: string, requestId: string, tokens: number, revision = 1) =>
    samples.observe(branch, identity, requestId, revision, { identity, estimatedTokens: tokens });
  expect(observe('a', 'model/credential/policy:1', 'one', 100)).toEqual({ durationMs: null, tokensPerMs: null, pendingTokens: 0 });
  const finish = samples.start('a', 'model/credential/policy:1')!;
  at = 100; observe('a', 'model/credential/policy:1', 'two', 200);
  at = 300; finish();
  expect(observe('a', 'model/credential/policy:1', 'three', 400)).toEqual({ durationMs: 300, tokensPerMs: 1, pendingTokens: 200 });
  at = 900;
  expect(observe('a', 'model/credential/policy:1', 'three', 400).tokensPerMs).toBe(1);
  expect(observe('b', 'model/credential/policy:1', 'one', 400).durationMs).toBeNull();
  expect(observe('a', 'model/credential/policy:1', 'four', 80, 2)).toEqual({ durationMs: 300, tokensPerMs: null, pendingTokens: 0 });
  const stale = samples.start('a', 'model/credential/policy:1')!;
  expect(observe('a', 'model/credential/policy:2', 'five', 80, 2).durationMs).toBeNull();
  at = 1000; stale();
  expect(observe('a', 'model/credential/policy:2', 'six', 100, 2).durationMs).toBeNull();
});
