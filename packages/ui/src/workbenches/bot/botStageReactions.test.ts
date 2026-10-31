import { describe, expect, it } from 'vitest';
import { BotReactionGrader, type BotReactionInput } from './botStageReactions';

const calm = (now: number) => ({ now, urgent: false, typing: false });

describe('Bot reactions', () => {
  it('starts from how close and how heavy the result is', () => {
    const levels = ([
      { kind: 'sub-report', outcome: 'ok' }, { kind: 'lead-report', outcome: 'ok' }, { kind: 'gather', outcome: 'ok' },
      { kind: 'reply', outcome: 'ok' }, { kind: 'complete', outcome: 'ok', weight: 'small' }, { kind: 'complete', outcome: 'fail', weight: 'large' },
      { kind: 'complete', outcome: 'ok', weight: 'large' },
    ] satisfies BotReactionInput[]).map((input, i) => new BotReactionGrader().grade(input, calm(i * 100)).level);
    expect(levels).toEqual([0, 1, 2, 3, 3, 3, 4]);
  });

  it('stays still while something needs you, and small while you type', () => {
    const grader = new BotReactionGrader();
    expect(grader.grade({ kind: 'reply', outcome: 'ok' }, { now: 0, urgent: true, typing: false })).toMatchObject({ level: 0, reasons: ['urgent'] });
    // Answering what needed you is still acknowledged.
    expect(grader.grade({ kind: 'resolved', outcome: 'ok' }, { now: 10, urgent: true, typing: false }).level).toBe(2);
    expect(grader.grade({ kind: 'complete', outcome: 'ok', weight: 'large' }, { now: 20, urgent: false, typing: true })).toMatchObject({ level: 1, reasons: ['large-success', 'typing'] });
  });

  it('joins repeats and does not glance twice in a row', () => {
    const grader = new BotReactionGrader();
    expect(grader.grade({ kind: 'lead-report', outcome: 'ok' }, calm(0)).level).toBe(1);
    expect(grader.grade({ kind: 'lead-report', outcome: 'ok' }, calm(.8))).toMatchObject({ level: 0, reasons: ['merged'] });
    // The merged one moved the window on, so this one still joins it.
    expect(grader.grade({ kind: 'lead-report', outcome: 'ok' }, calm(1.9)).reasons).toEqual(['merged']);
    expect(grader.grade({ kind: 'leave', outcome: 'ok' }, calm(2.5))).toMatchObject({ level: 1 });
    expect(grader.grade({ kind: 'leave', outcome: 'ok' }, calm(3.8))).toMatchObject({ level: 0, reasons: ['glance-cooldown'] });
  });

  it('spends a small budget, and what was said to you keeps at least a nod', () => {
    const grader = new BotReactionGrader();
    expect(grader.grade({ kind: 'reply', outcome: 'ok' }, calm(0)).level).toBe(3);
    expect(grader.grade({ kind: 'reply', outcome: 'ok' }, calm(2)).level).toBe(3);
    expect(grader.grade({ kind: 'reply', outcome: 'ok' }, calm(4))).toMatchObject({ level: 2, reasons: ['energy', 'floor'] });
    expect(grader.grade({ kind: 'gather', outcome: 'ok' }, calm(6))).toMatchObject({ level: 1, reasons: ['energy'] });
    // A minute later the budget is back.
    expect(grader.grade({ kind: 'complete', outcome: 'ok', weight: 'large' }, calm(66)).level).toBe(4);
  });
});
