import { expect, it } from 'vitest';
import { createDirectorReviewFixtureSession } from './directorReviewFixtures';
const teamFor = (frame: ReturnType<ReturnType<typeof createDirectorReviewFixtureSession>['view']>, name: string) => {
  const key = frame.projection.legend.find(item => item.identity.threadId === `review-thread-${name}`)?.key;
  return frame.projection.portfolio.teams?.find(team => team.projectKey === key);
};

it('uses real projection contracts for three leads and keeps A children alive when Varin replies with B’s result', () => {
  const session = createDirectorReviewFixtureSession();
  expect(session.view().projection.portfolio.projects).toHaveLength(3);
  session.step('b-result');
  const frame = session.view();
  expect(frame.reviewOnly).toBe(true);
  // B's own Run end and report are not the beat; Varin's public reply is.
  expect(frame.presentation.body.edge).toMatchObject({ kind: 'present-reply', runId: 'review-run-entry', outcome: 'completed' });
  expect(frame.presentation.body.verb).toBe('present-reply');
  expect(teamFor(frame, 'a')?.members).toHaveLength(1);
  expect(teamFor(frame, 'c')?.members).toHaveLength(1);
  expect(teamFor(frame, 'a')?.members[0]?.key).not.toBe(teamFor(frame, 'c')?.members[0]?.key);
  expect(teamFor(frame, 'b')?.members).toEqual([]);
  expect(teamFor(frame, 'a')?.members[0]?.state).toBe('running');
  expect(frame.attention.teamExecutions[0]?.parentRunId).toBe(frame.attention.branches[0]?.currentRun?.id);
  const edge = frame.presentation.body.edge!;
  session.consumeEdge(edge.key);
  expect(session.view().presentation.body.edge).toBeNull();
  expect(session.view().presentation.body.verb).toBe('review-portfolio');
});
it('keeps independent permission/question ownership and resolves only B', () => {
  const session = createDirectorReviewFixtureSession(); session.step('requests');
  const before = session.view();
  expect(before.projection.portfolio.projects.map(card => card.notice).filter(Boolean).sort()).toEqual(['permission', 'question']);
  const question = before.attention.items.find(item => item.kind === 'question')!;
  for (const item of before.attention.items) expect(before.attention.branches.find(branch => branch.branchId === item.branchId)?.currentRun?.id).toBe(item.runId);
  session.step('b-resolved'); const after = session.view();
  expect(after.attention.items).toEqual([question]);
  expect(after.projection.portfolio.projects.map(card => card.notice).filter(Boolean)).toEqual(['question']);
  expect(after.attention.counts.actionRequired).toBe(1);
});
it('unknown retains identities without stale team and reconnect never replays historical outcomes', () => {
  const session = createDirectorReviewFixtureSession(); session.step('unknown');
  const unknown = session.view();
  expect(unknown.projection.portfolio.projects).toHaveLength(3);
  expect(unknown.projection.portfolio.projects.every(card => card.status === 'unknown' && card.requestCount === null)).toBe(true);
  expect(unknown.projection.portfolio.teams).toBeUndefined();
  session.step('reconnected'); const restored = session.view();
  expect(restored.projection.sourceCurrent).toBe(true);
  expect(restored.presentation.body.edge).toBeNull();
  expect(teamFor(restored, 'a')?.members).toHaveLength(1);
  session.step('b-result'); session.view({ visible: false });
  expect(session.view({ visible: true }).presentation.body.edge).toBeNull();
  expect(session.view({ hideTaskNames: true }).projection.portfolio.projects.every(card => card.caption === undefined)).toBe(true);
});

it('observes a genuinely new B dispatch even when the snapshot already sees execution before producing intake, independently of A inspection', () => {
  const session = createDirectorReviewFixtureSession();
  session.step('b-intake');
  const frame = session.view();
  expect(frame.presentation.body.verb).toBe('receive-work');
  expect(frame.presentation.body.edge).toMatchObject({ kind: 'receive-work', runId: 'review-run-b', project: { threadId: 'review-thread-b', branchId: 'review-branch-b' }, outcome: null });
  expect(frame.presentation.inspection?.identity.threadId).toBe('review-thread-a');
  expect(frame.attention.branches.find(branch => branch.threadId === 'review-thread-b')?.currentRun?.state).toBe('executing');
  expect(frame.projection.portfolio.mode).toBe('intake');
  const subject = frame.projection.portfolio.projects.find(card => card.key === frame.projection.portfolio.subjectKey);
  expect(subject).toMatchObject({ caption: '页面方案', lead: { role: 'project-lead' } });
  expect(teamFor(frame, 'a')?.members[0]?.state).toBe('running');
  session.consumeEdge(frame.presentation.body.edge!.key);
  expect(session.view().presentation.body.edge).toBeNull();
  session.step('b-intake'); session.view({ interacting: true });
  expect(session.view({ interacting: false }).presentation.body.edge).toBeNull();
});

it('retires only the exact terminal child squad member, retaining the other project’s live child', () => {
  const session = createDirectorReviewFixtureSession(); session.step('team-active');
  const before = session.view(); const cKey = teamFor(before, 'c')?.members[0]?.key;
  session.step('a-child-ended'); const after = session.view();
  expect(teamFor(after, 'a')?.members).toEqual([]);
  expect(teamFor(after, 'c')?.members[0]?.key).toBe(cKey);
  expect(teamFor(after, 'c')?.members[0]?.state).toBe('running');
  expect(after.presentation.body.edge).toBeNull();
});
