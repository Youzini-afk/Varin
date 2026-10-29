import { expect, it } from 'vitest';
import type { ThreadAttentionItem, ThreadAttentionSnapshot } from '@varin/application-client';
import { CompanionAttentionLedger } from './attentionLedger';
const item = (key: string, kind: ThreadAttentionItem['kind'] = 'permission'): ThreadAttentionItem => ({ key, threadId: key, branchId: 'branch', runId: 'run', kind, actionable: kind === 'permission', revision: 1 });
const facts = (items: ThreadAttentionItem[], epoch=1) => ({ epoch, items }) as ThreadAttentionSnapshot;
it('keeps stable pending order, viewed is not resolved, and never drops a lower-priority pending request', () => {
  const ledger = new CompanionAttentionLedger();
  ledger.reconcile(facts([item('B'),item('C')])); ledger.markViewed('B');
  const rows=ledger.reconcile(facts([item('D','effect_unknown'),item('C'),item('B'),item('E')]));
  expect(rows.map(row=>row.key)).toEqual(['D','B','C','E']); expect(ledger.isViewed('B')).toBe(true);
  expect(ledger.reconcile(facts([item('C'),item('E')])).map(row=>row.key)).toEqual(['C','E']);
  expect(ledger.isViewed('B')).toBe(false);
});
it('does not carry viewed receipts or ordering to a new epoch', () => {
  const ledger=new CompanionAttentionLedger();ledger.reconcile(facts([item('B'),item('C')]));ledger.markViewed('B');
  expect(ledger.reconcile(facts([item('C'),item('B')],2)).map(row=>row.key)).toEqual(['C','B']);
  expect(ledger.isViewed('B')).toBe(false);
});
