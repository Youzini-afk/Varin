import { describe, expect, test } from 'bun:test';
import type { SessionSnapshot } from '@varin/protocol';
import { projectPiSessionActivity } from './sessionActivity';

const snapshot = (patch: Partial<SessionSnapshot> = {}): SessionSnapshot => ({
  activeTools: [],
  busy: false,
  cwd: 'C:/repo',
  features: { revision: 0, schemaVersion: 1 },
  followUp: [],
  followUpMode: 'all',
  queuedMessages: [],
  isCompacting: false,
  isStreaming: false,
  leafId: null,
  pendingMessageCount: 0,
  retryAttempt: 0,
  sessionId: 'session-1',
  steering: [],
  steeringMode: 'all',
  thinkingLevel: 'off',
  ...patch,
});

describe('projectPiSessionActivity', () => {
  test('is idle without a snapshot or active runtime work', () => {
    expect(projectPiSessionActivity(undefined).phase).toBe('idle');
    expect(projectPiSessionActivity(snapshot()).isWorking).toBe(false);
  });

  test('projects every active Pi runtime flag as busy', () => {
    for (const patch of [
      { busy: true },
      { isStreaming: true },
      { isCompacting: true },
    ]) {
      expect(projectPiSessionActivity(snapshot(patch))).toEqual({
        isBusy: true,
        isCooldown: false,
        isWorking: true,
        phase: 'busy',
      });
    }
  });

  test('gives retry precedence over other busy flags', () => {
    expect(projectPiSessionActivity(snapshot({ busy: true, retryAttempt: 2 }))).toEqual({
      isBusy: false,
      isCooldown: true,
      isWorking: true,
      phase: 'retry',
    });
  });
});
