import { describe, expect, test } from 'vitest';
import { piLensDraftIssues } from './pi-lens-config-model';

describe('pi-lens config model', () => {
  test('treats a missing field as unset without inventing a default', () => {
    expect(piLensDraftIssues({}, 'global')).toEqual([]);
  });

  test('reports an invalid known enum while retaining its path for Advanced', () => {
    expect(piLensDraftIssues({ format: { mode: 'immedaite' } }, 'global').some((issue) => (
      issue.code === 'invalid-value' && issue.field === 'format.mode'
    ))).toBe(true);
  });

  test('does not reject unknown keys, so Advanced can preserve them', () => {
    expect(piLensDraftIssues({ futureSetting: { enabled: 'later' } }, 'global')).toEqual([]);
  });

  test('diagnoses a global-only project key without deleting it', () => {
    expect(piLensDraftIssues({ lsp: { enabled: false }, futureProjectKey: true }, 'project').some((issue) => (
      issue.code === 'project-global-only' && issue.field === 'lsp.enabled'
    ))).toBe(true);
  });

  test('validates project-native security and size controls', () => {
    const issues = piLensDraftIssues({
      maxProjectFiles: 0,
      trivy: { minSeverity: 'urgent' },
      helm: { renderValidation: { enabled: true } },
    }, 'project');
    expect(issues.some((issue) => issue.code === 'invalid-number' && issue.field === 'maxProjectFiles')).toBe(true);
    expect(issues.some((issue) => issue.code === 'invalid-value' && issue.field === 'trivy.minSeverity')).toBe(true);
  });

  test('accepts the numeric-string review graph budget supported by pi-lens', () => {
    expect(piLensDraftIssues({ reviewGraph: { maxFiles: '12000' } }, 'project')).toEqual([]);
  });
});
