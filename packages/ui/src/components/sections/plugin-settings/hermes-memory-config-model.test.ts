import { describe, expect, test } from 'vitest';
import { updateJsoncPath } from './plugin-config-model';
import {
  hermesAgentRootFromAuthorityPath,
  hermesMemoryDraftIssues,
  type HermesMemoryDraftIssue,
  normalizeHermesProjectsMemoryDir,
  validHermesProjectsMemoryDir,
} from './hermes-memory-config-model';

const expectIssue = (
  issues: readonly HermesMemoryDraftIssue[],
  expected: HermesMemoryDraftIssue,
): void => {
  expect(issues.some((issue) => (
    issue.blocking === expected.blocking
    && issue.code === expected.code
    && issue.field === expected.field
  ))).toBe(true);
};

describe('Hermes Memory config model', () => {
  test('preserves unknown top-level fields and diagnoses them without blocking save', () => {
    const draft = { reviewEnabled: true, futureReviewMode: { cadence: 'later' } };
    const before = structuredClone(draft);

    const issues = hermesMemoryDraftIssues(draft);

    expect(draft).toEqual(before);
    expectIssue(issues, {
      blocking: false,
      code: 'unknown-field',
      field: 'futureReviewMode',
    });
    expect(issues.some((issue) => issue.blocking)).toBe(false);
  });

  test('blocks invalid known booleans, enums, strings, arrays, objects, and numbers', () => {
    const issues = hermesMemoryDraftIssues({
      reviewEnabled: 'yes',
      memoryMode: 'inject',
      memoryPolicyCustomText: false,
      memoryCharLimit: '5000',
      childExtensionPaths: ['valid', 4],
      sessionSearch: { variant: 'future' },
      llmModelOverride: '   ',
    });
    const blocking = issues.filter((issue) => issue.blocking);

    expectIssue(blocking, { blocking: true, code: 'invalid-boolean', field: 'reviewEnabled' });
    expectIssue(blocking, { blocking: true, code: 'invalid-value', field: 'memoryMode' });
    expectIssue(blocking, { blocking: true, code: 'invalid-value', field: 'memoryPolicyCustomText' });
    expectIssue(blocking, { blocking: true, code: 'invalid-number', field: 'memoryCharLimit' });
    expectIssue(blocking, { blocking: true, code: 'invalid-value', field: 'childExtensionPaths' });
    expectIssue(blocking, { blocking: true, code: 'invalid-value', field: 'sessionSearch.variant' });
    expectIssue(blocking, { blocking: true, code: 'invalid-value', field: 'llmModelOverride' });
  });

  test('matches the loader numeric semantics without inventing integer or positive bounds', () => {
    expect(hermesMemoryDraftIssues({
      memoryCharLimit: -1.25,
      userCharLimit: 0.5,
      projectCharLimit: -4,
      nudgeInterval: -2.5,
      nudgeToolCalls: 0.25,
      flushMinTurns: -3,
      consolidationTimeoutMs: -1,
      failureInjectionMaxAgeDays: -7.5,
      failureInjectionMaxEntries: -2,
      reviewRecentMessages: 0.5,
      flushRecentMessages: 0,
      overflowGraceMs: 4.25,
    }).filter((issue) => issue.blocking)).toEqual([]);

    const invalid = hermesMemoryDraftIssues({
      reviewRecentMessages: -0.1,
      flushRecentMessages: -1,
      overflowGraceMs: -2,
    });
    expect(invalid.filter((issue) => issue.code === 'invalid-number').map((issue) => issue.field).sort())
      .toEqual(['flushRecentMessages', 'overflowGraceMs', 'reviewRecentMessages']);
  });

  test('mirrors Hermes 0.9.6 projectsMemoryDir normalization against the active agent root', () => {
    const posixRoot = '/home/u/.pi/agent';
    const windowsRoot = 'C:\\Users\\u\\.pi\\agent';

    expect(hermesAgentRootFromAuthorityPath(`${posixRoot}/hermes-memory-config.json`)).toBe(posixRoot);
    expect(hermesAgentRootFromAuthorityPath(`${windowsRoot}\\hermes-memory-config.json`)).toBe(windowsRoot);

    expect(validHermesProjectsMemoryDir('projects-memory', posixRoot)).toBe(true);
    expect(validHermesProjectsMemoryDir('./team', posixRoot)).toBe(true);
    expect(validHermesProjectsMemoryDir('nested/../team', posixRoot)).toBe(true);
    expect(validHermesProjectsMemoryDir('/home/u/.pi/agent/team', posixRoot)).toBe(true);
    expect(validHermesProjectsMemoryDir('C:\\Users\\u\\.pi\\agent\\team', windowsRoot)).toBe(true);
    expect(validHermesProjectsMemoryDir('~/.pi/agent/team', posixRoot)).toBe(true);
    expect(normalizeHermesProjectsMemoryDir('./team', posixRoot)).toBe('team');
    expect(validHermesProjectsMemoryDir('..team', posixRoot)).toBe(true);

    const customWindowsRoot = 'D:\\work\\pi-agent';
    expect(validHermesProjectsMemoryDir('team', customWindowsRoot)).toBe(true);
    expect(validHermesProjectsMemoryDir('D:\\work\\pi-agent\\team', customWindowsRoot)).toBe(true);
    expect(validHermesProjectsMemoryDir('D:\\work\\pi-agent\\team\\nested', customWindowsRoot)).toBe(false);
    expect(validHermesProjectsMemoryDir('E:\\other\\team', customWindowsRoot)).toBe(false);
    expect(validHermesProjectsMemoryDir(
      '~/outside',
      customWindowsRoot,
      'C:\\Users\\u',
    )).toBe(false);

    expect(validHermesProjectsMemoryDir('/home/u/.pi/agent', posixRoot)).toBe(false);
    expect(validHermesProjectsMemoryDir('/home/u/team', posixRoot)).toBe(false);
    expect(validHermesProjectsMemoryDir('/home/u/.pi/agent/team/nested', posixRoot)).toBe(false);
    expect(validHermesProjectsMemoryDir('../team', posixRoot)).toBe(false);
    expect(validHermesProjectsMemoryDir('~/outside', posixRoot)).toBe(false);
    expect(validHermesProjectsMemoryDir('foo\\bar', posixRoot)).toBe(false);
    expect(validHermesProjectsMemoryDir('..\\escape', posixRoot)).toBe(false);
    expect(validHermesProjectsMemoryDir('', posixRoot)).toBe(false);
    expect(validHermesProjectsMemoryDir('nested/path', posixRoot)).toBe(false);
    expect(validHermesProjectsMemoryDir('C:\\memory', windowsRoot)).toBe(false);
    expect(validHermesProjectsMemoryDir('team\0nested', posixRoot)).toBe(false);

    expect(hermesMemoryDraftIssues(
      { projectsMemoryDir: '/home/u/.pi/agent/team' },
      { agentRoot: posixRoot },
    ).some((issue) => issue.field === 'projectsMemoryDir')).toBe(false);
    expectIssue(hermesMemoryDraftIssues(
      { projectsMemoryDir: '/home/u/.pi/agent' },
      { agentRoot: posixRoot },
    ), {
      blocking: true,
      code: 'invalid-value',
      field: 'projectsMemoryDir',
    });
    expectIssue(hermesMemoryDraftIssues({ projectsMemoryDir: '../outside' }, { agentRoot: posixRoot }), {
      blocking: true,
      code: 'invalid-value',
      field: 'projectsMemoryDir',
    });
    expectIssue(hermesMemoryDraftIssues({ projectsMemoryDir: '~/outside' }, { agentRoot: posixRoot }), {
      blocking: true,
      code: 'invalid-value',
      field: 'projectsMemoryDir',
    });
  });

  test('keeps legacy and modern overflow fields unchanged while reporting modern precedence', () => {
    const draft = {
      autoConsolidate: false,
      memoryOverflowStrategy: 'fifo-evict',
    } as const;
    const before = structuredClone(draft);

    const issues = hermesMemoryDraftIssues(draft);
    const next = updateJsoncPath(JSON.stringify(draft, null, 2), ['memoryOverflowStrategy'], 'reject');

    expect(draft).toEqual(before);
    expectIssue(issues, {
      blocking: false,
      code: 'modern-overrides-legacy',
      field: 'autoConsolidate',
    });
    expect(JSON.parse(next)).toEqual({ autoConsolidate: false, memoryOverflowStrategy: 'reject' });
    expect(issues.some((issue) => issue.code === 'unknown-field' && issue.field === 'autoConsolidate')).toBe(false);
  });
});
