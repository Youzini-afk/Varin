import { expect, test } from 'vitest';
import type { ThreadSnapshot } from '@varin/application-client';
import { CompanionSceneFacts } from './sceneFacts';
import { companionReceipt, consumeCompanionReceipt, currentCompanionReceipt, newlyAnsweredQuestion, projectCompanionIntent } from './presentation';

const snapshot = (operations: unknown[]) => ({ operations, childActivity: {}, activeRun: null } as unknown as ThreadSnapshot);
const question = (id: string, answered = false) => ({ id, executor: 'ask_user', phase: answered ? 'terminal' : 'waiting',
  ...(answered ? { outcome: 'succeeded', result: { kind: 'control', value: { answer_ref: `answer-${id}` } } } : {}) });

test('matched answers share one scope-bound beat; old completion cannot consume a replacement or replay across routes', () => {
  const scope = JSON.stringify([1, 2, 'thread', 'branch', 'agent-companion', true]);
  const answered = newlyAnsweredQuestion(new Set(['q1']), snapshot([question('q1', true)]));
  expect(answered).toBe('q1');
  expect(newlyAnsweredQuestion(new Set(), snapshot([question('q1', true)]))).toBeNull();
  const first = companionReceipt(scope, { kind: 'question', operationId: answered!, outcome: 'answered' });
  expect(currentCompanionReceipt(first, scope, false)).toBe(first);
  expect(currentCompanionReceipt(first, scope, false, 'new-run')).toBeNull();
  for (const other of [scope + '-generation', scope + '-branch', scope + '-ordinary', scope + '-bot'])
    expect(currentCompanionReceipt(first, other, false)).toBeNull();
  const next = companionReceipt(scope, { kind: 'question', operationId: 'q2', outcome: 'answered' });
  expect(consumeCompanionReceipt(next, first!.key)).toBe(next);
  expect(consumeCompanionReceipt(next, next!.key)).toBeNull();
  expect(currentCompanionReceipt(consumeCompanionReceipt(first, first!.key), scope, false)).toBeNull();
});

test('actual matched permission proof excludes denial and newer pending wins without delayed acknowledgement', () => {
  const facts = new CompanionSceneFacts();
  const permission = (decision: string | null) => ({ id: 'op', phase: decision ? 'terminal' : 'waiting',
    result: { kind: 'control', value: { permission: { id: 'permission-1', decision, call: {}, scope: {} } } } });
  facts.observe(snapshot([permission(null)]), 'current');
  facts.observe(snapshot([permission('allow_once')]), 'current');
  const receipt = companionReceipt('scope', facts.matchedReceipt!);
  expect(receipt).toMatchObject({ operationId: 'op', permissionId: 'permission-1' });
  const pending = projectCompanionIntent(snapshot([question('new')]), 'current');
  const discarded = currentCompanionReceipt(receipt, 'scope', pending.state === 'W03');
  expect(discarded).toBeNull();
  expect(currentCompanionReceipt(discarded, 'scope', false)).toBeNull();
  facts.observe(snapshot([permission(null)]), 'current');
  facts.observe(snapshot([permission('deny')]), 'current');
  expect(companionReceipt('scope', facts.matchedReceipt!)).toBeNull();
  // Same discard operation is used for hidden/drag/manual/finite-handover priority.
  expect(currentCompanionReceipt(receipt, 'scope', true)).toBeNull();
});
