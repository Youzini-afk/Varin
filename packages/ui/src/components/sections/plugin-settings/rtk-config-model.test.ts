import { describe, expect, test } from 'vitest';
import { updateJsoncPath } from './plugin-config-model';
import { rtkDraftIssues } from './rtk-config-model';
import { parsePluginTextObjectDraft } from './usePluginConfigDraft';

describe('RTK optimizer config model', () => {
  test('keeps a missing document empty instead of materializing plugin defaults', () => {
    const draft = {};
    expect(rtkDraftIssues(draft)).toEqual([]);
    expect(draft).toEqual({});
  });

  test('uses strict JSON rather than accepting JSONC syntax', () => {
    const strict = parsePluginTextObjectDraft('{\n  "enabled": true\n}\n', 'json');
    const comment = parsePluginTextObjectDraft('{\n  // not strict JSON\n  "enabled": true\n}\n', 'json');
    const trailingComma = parsePluginTextObjectDraft('{\n  "enabled": true,\n}\n', 'json');

    expect(strict).toEqual({ draft: { enabled: true }, rawError: null });
    expect(comment.rawError).not.toBeNull();
    expect(trailingComma.rawError).not.toBeNull();

    const bomDocument = `\uFEFF{\n  "enabled": true\n}\n`;
    const bom = parsePluginTextObjectDraft(bomDocument, 'json');
    expect(bom.rawError).not.toBeNull();
    expect(bom.draft).toEqual({});
    expect(parsePluginTextObjectDraft(bomDocument.replace(/^\uFEFF/, ''), 'json')).toEqual({
      draft: { enabled: true },
      rawError: null,
    });
  });

  test('accepts the current native configuration tree and exact numeric ranges', () => {
    const draft = {
      enabled: true,
      mode: 'suggest',
      guardWhenRtkMissing: false,
      showRewriteNotifications: true,
      outputCompaction: {
        enabled: true,
        stripAnsi: false,
        readCompaction: { enabled: true },
        sourceCodeFilteringEnabled: true,
        preserveExactSkillReads: true,
        sourceCodeFiltering: 'aggressive',
        smartTruncate: { enabled: true, maxLines: 40 },
        truncate: { enabled: true, maxChars: 200_000 },
        aggregateTestOutput: true,
        filterBuildOutput: true,
        compactGitOutput: true,
        aggregateLinterOutput: true,
        groupSearchOutput: true,
        trackSavings: true,
      },
    } as const;
    expect(rtkDraftIssues(draft)).toEqual([]);
  });

  test('blocks invalid known values without imposing unsupported numeric ranges', () => {
    const issues = rtkDraftIssues({
      enabled: 'yes',
      mode: 'automatic',
      outputCompaction: {
        readCompaction: false,
        sourceCodeFiltering: 'extreme',
        smartTruncate: { enabled: true, maxLines: 39 },
        truncate: { enabled: true, maxChars: 200_001 },
      },
    });
    const blocking = issues.filter((issue) => issue.blocking);
    const hasBlockingIssue = (code: string, field: string): boolean => blocking.some((issue) => (
      issue.code === code && issue.field === field
    ));
    expect(hasBlockingIssue('invalid-boolean', 'enabled')).toBe(true);
    expect(hasBlockingIssue('invalid-value', 'mode')).toBe(true);
    expect(hasBlockingIssue('invalid-value', 'outputCompaction.readCompaction')).toBe(true);
    expect(hasBlockingIssue('invalid-value', 'outputCompaction.sourceCodeFiltering')).toBe(true);
    expect(hasBlockingIssue('invalid-number', 'outputCompaction.smartTruncate.maxLines')).toBe(true);
    expect(hasBlockingIssue('invalid-number', 'outputCompaction.truncate.maxChars')).toBe(true);

    expect(rtkDraftIssues({
      outputCompaction: {
        smartTruncate: { maxLines: 4_000 },
        truncate: { maxChars: 1_000 },
      },
    }).filter((issue) => issue.blocking)).toEqual([]);
  });

  test('preserves unknown and removed legacy fields in the same Advanced draft', () => {
    const source = `{
  "enabled": true,
  "rewriteGitGithub": false,
  "outputCompaction": {
    "futureTechnique": { "enabled": true }
  },
  "futureTopLevel": "keep"
}\n`;
    const draft = JSON.parse(source);
    const issues = rtkDraftIssues(draft);
    const next = updateJsoncPath(source, ['enabled'], false);

    expect(issues.filter((issue) => issue.code === 'unknown-field').map((issue) => issue.field).sort())
      .toEqual(['futureTopLevel', 'outputCompaction.futureTechnique', 'rewriteGitGithub']);
    expect(issues.some((issue) => issue.blocking)).toBe(false);
    expect(JSON.parse(next)).toEqual({
      enabled: false,
      rewriteGitGithub: false,
      outputCompaction: { futureTechnique: { enabled: true } },
      futureTopLevel: 'keep',
    });
  });
});
