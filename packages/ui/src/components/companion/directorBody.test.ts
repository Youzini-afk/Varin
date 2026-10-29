import { expect, it } from 'vitest';
import { directorBodyAction } from './directorBody';
import type { DirectorPresentation } from './directorPresentation';
const view: DirectorPresentation = { health: 'current', source: null, body: { verb: 'review-portfolio', subject: null, attentionOwner: null, attentionMode: null, attentionItem: null, edge: null }, cards: [], overflowCards: 0, inspectedProjectKey: null, inspection: null, counts: null, coverage: null };
it('uses direction only for actual managerial attention, not project tool changes', () => {
  expect(directorBodyAction(view, 'left')).toBe('director-supervise');
  const inspection = { ...view, inspectedProjectKey: 'project-1' };
  expect(directorBodyAction(inspection, 'left')).toBe('director-listen-left');
  expect(directorBodyAction(inspection, 'right')).toBe('director-listen-right');
  expect(directorBodyAction(inspection, null)).toBe('director-supervise');
});
it('presents scoped results/attention without a global success or approval action', () => {
  expect(directorBodyAction({ ...view, body: { ...view.body, verb: 'present-attention' } }, 'right')).toBe('director-gather-present');
  expect(directorBodyAction({ ...view, body: { ...view.body, verb: 'receive-result' } }, 'right')).toBe('director-gather-present');
  expect(directorBodyAction({ ...view, health: 'unknown', inspectedProjectKey: 'project-1' }, 'right')).toBe('director-supervise');
});

it('receives and hands off a project without depending on inspection dock direction',()=>{
 expect(directorBodyAction({...view,body:{...view.body,verb:'receive-work'}},null)).toBe('director-intake');
});
