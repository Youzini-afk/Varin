import { afterEach, describe, expect, test } from 'vitest';
import { threadHostKey as getRuntimeKey } from '@/stores/useThreadStore';
import { addEditorContextAttachment, consumeEditorContextAttachments, listEditorContextAttachments, resetEditorContextAttachments, acknowledgeEditorContextAttachments, restoreEditorContextAttachments } from './attachments';
import { projectEditorContextAttachments } from './projection';
import { extractToolFileChanges, recordHintsFromToolCall, peekAgentFileChangeHint, resetAgentFileChangeHints } from './hints';
import { applyHunkDecisions, parseUnifiedHunks } from './patch';
import { computeThreeWayMerge, applyMergeDecisions } from './merge';
import { sliceDocumentRange } from './range';
import type { EditorContextAttachment } from './types';

const runtimeKey = getRuntimeKey();

afterEach(() => {
  resetEditorContextAttachments();
  resetAgentFileChangeHints();
});

const attachment = (overrides: Partial<EditorContextAttachment> = {}): EditorContextAttachment => ({
  id: overrides.id ?? 'att-1',
  runtimeKey,
  threadKey: 'session-a',
  workspaceId: 'ws-1',
  resourceId: 'src/a.ts',
  label: 'a.ts',
  documentInstanceId: 'document-a',
  documentRevision: 'rev-1',
  localEditRevision: 3,
  source: 'saved',
  kind: 'editor',
  ...overrides,
});

describe('editor context attachments', () => {
  test('consume is scoped to runtime and session', () => {
    addEditorContextAttachment(attachment());
    addEditorContextAttachment(attachment({ id: 'att-2', threadKey: 'session-b', resourceId: 'src/b.ts' }));
    expect(listEditorContextAttachments(runtimeKey, 'session-a')).toHaveLength(1);
    const taken = consumeEditorContextAttachments(runtimeKey, 'session-a');
    expect(taken).toHaveLength(1);
    expect(listEditorContextAttachments(runtimeKey, 'session-a')).toHaveLength(0);
    expect(listEditorContextAttachments(runtimeKey, 'session-b')).toHaveLength(1);
    restoreEditorContextAttachments(taken);
    expect(listEditorContextAttachments(runtimeKey, 'session-a')).toHaveLength(1);
  });

  test('workspace-scoped consumers cannot take another workspace attachment from the same session', () => {
    addEditorContextAttachment(attachment());
    addEditorContextAttachment(attachment({
      id: 'att-2',
      workspaceId: 'ws-2',
      resourceId: 'src/b.ts',
      documentInstanceId: 'document-b',
    }));
    expect(consumeEditorContextAttachments(runtimeKey, 'session-a', 'ws-1')).toHaveLength(1);
    expect(listEditorContextAttachments(runtimeKey, 'session-a', 'ws-2')).toHaveLength(1);
  });

  test('rejects attachments captured for another runtime', () => {
    expect(addEditorContextAttachment(attachment({ runtimeKey: 'other-host' }))).toEqual({ status: 'wrong-runtime' });
  });

  test('refreshes the same logical attachment instead of retaining a stale buffer snapshot', () => {
    addEditorContextAttachment(attachment({ source: 'unsaved-buffer', text: 'old', localEditRevision: 3 }));
    const refreshed = addEditorContextAttachment(attachment({
      id: 'att-new',
      source: 'unsaved-buffer',
      text: 'new',
      localEditRevision: 4,
    }));
    expect('status' in refreshed).toBe(false);
    if ('status' in refreshed) throw new Error(refreshed.status);
    expect(refreshed.id).toBe('att-1');
    expect(refreshed.text).toBe('new');
    expect(refreshed.localEditRevision).toBe(4);
    expect(listEditorContextAttachments(runtimeKey, 'session-a')).toHaveLength(1);
  });
});

describe('unsaved attachment projection', () => {
  test('saved attachments do not include buffer text and unsaved ones say disk cannot see them', () => {
    const saved = projectEditorContextAttachments('Please review', [attachment()]);
    expect(saved).toContain('Attached saved file');
    expect(saved).toContain('src/a.ts');
    expect(saved).not.toMatch(/revision|rev-1|document-a/);
    expect(saved).not.toContain('const value');
    const unsaved = projectEditorContextAttachments('', [attachment({
      source: 'unsaved-buffer',
      kind: 'selection',
      text: 'const value = 1;',
      languageId: 'typescript',
    })]);
    expect(unsaved).toContain('Unsaved editor content; file tools read the saved file on disk');
    expect(unsaved).toContain('const value = 1;');
  });

  test('test failures and stack frames retain their material and location', () => {
    const projected = projectEditorContextAttachments('', [
      attachment({
        kind: 'test-failure',
        diagnosticMessage: 'expected 2, got 3',
        text: 'Error: expected 2, got 3\n    at fail.test.js:1:1',
        label: 'fails',
        resourceId: 'fail.test.js',
      }),
      attachment({
        id: 'att-stack',
        kind: 'stack',
        diagnosticMessage: 'fixtureMain:1',
        label: 'fixtureMain',
        resourceId: 'app.js',
        range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 },
      }),
    ]);
    expect(projected).toContain('Attached test failure');
    expect(projected).toContain('Error: expected 2, got 3\n    at fail.test.js:1:1');
    expect(projected).toContain('Attached stack frame');
    expect(projected).toContain('app.js');
    expect(projected).toContain('1:1-1:1');
    expect(projected).not.toContain('does not grant');
  });
  test('equal paths from different captured projects include readable sources', () => {
    const projected = projectEditorContextAttachments('', [
      attachment({ sourceLabel: '/work/project-a', workspaceId: 'a' }),
      attachment({ sourceLabel: '/work/project-b', workspaceId: 'b' }),
    ]);
    expect(projected).toContain('- Source: /work/project-a');
    expect(projected).toContain('- Source: /work/project-b');
    expect(projectEditorContextAttachments('', [attachment({ sourceLabel: '/work/project-a' })])).not.toContain('- Source:');
  });

  test('unsaved diff and diagnostic preserve Unicode, ranges and original fence contents', () => {
    const patch = '@@ -1 +1 @@\n-旧值\n+新值 ```';
    const projected = projectEditorContextAttachments('Keep my comment', [
      attachment({ kind: 'diff', source: 'unsaved-buffer', patch }),
      attachment({ kind: 'diagnostic', diagnosticMessage: 'Type mismatch', text: 'const x = `原文`;',
        range: { startLine: 3, startColumn: 2, endLine: 4, endColumn: 8 } }),
    ]);
    expect(projected).toContain(patch);
    expect(projected).toContain('Unsaved editor content');
    expect(projected).toContain('3:2-4:8');
    expect(projected).toContain('const x = `原文`;');
    expect(projected.startsWith('Keep my comment')).toBe(true);
    expect(projected).not.toContain('rev-1');
  });

});

describe('agent file change hints', () => {
  test('extracts write and apply_patch paths without copying plugin history', () => {
    expect(extractToolFileChanges('write', { path: 'src/a.ts', content: 'secret' })).toEqual([
      { path: 'src/a.ts', kind: 'write' },
    ]);
    expect(extractToolFileChanges('apply_patch', {
      patchText: '*** Begin Patch\n*** Update File: src/b.ts\n@@ -1 +1 @@\n-a\n+b\n*** End Patch\n',
    })).toEqual([{ path: 'src/b.ts', kind: 'patch' }]);
    expect(extractToolFileChanges('bash', { command: 'rm src/a.ts' })).toEqual([]);
  });

  test('records a hint that watcher reconciliation can read', () => {
    recordHintsFromToolCall({
      runtimeKey,
      threadKey: 'session-a',
      toolCallId: 'tool-1',
      toolName: 'write',
      args: { filePath: 'D:/work/src/a.ts' },
      workspaceId: 'ws-1',
      workspaceRoot: 'D:/work',
    });
    expect(peekAgentFileChangeHint({ workspaceId: 'ws-1', resourceId: 'src/a.ts' })?.toolCallId).toBe('tool-1');
  });

  test('does not project tool paths outside the authoritative workspace', () => {
    expect(recordHintsFromToolCall({
      runtimeKey,
      threadKey: 'session-a',
      toolCallId: 'tool-outside',
      toolName: 'write',
      args: { path: '../outside.txt' },
      workspaceId: 'ws-1',
      workspaceRoot: '/workspace',
    })).toEqual([]);
  });
});

describe('patch hunk apply and revert', () => {
  const original = 'one\ntwo\nthree';
  const patch = [
    '@@ -1,3 +1,3 @@',
    ' one',
    '-two',
    '+TWO',
    ' three',
  ].join('\n');

  test('accepts and rejects hunks without applying mismatched text', () => {
    const hunks = parseUnifiedHunks(patch);
    expect(hunks).toHaveLength(1);
    expect(applyHunkDecisions(original, hunks, ['accept'])).toEqual({ status: 'applied', content: 'one\nTWO\nthree' });
    expect(applyHunkDecisions(original, hunks, ['reject'])).toEqual({ status: 'applied', content: original });
    expect(applyHunkDecisions(original, hunks, ['accept'], 'revert').status).toBe('mismatch');
    expect(applyHunkDecisions('one\nTWO\nthree', hunks, ['accept'], 'revert')).toEqual({
      status: 'applied',
      content: original,
    });
  });
});

describe('three-way merge', () => {
  test('classifies ours, theirs, and overlapping conflict', () => {
    expect(computeThreeWayMerge('base', 'base', 'theirs')).toEqual([{ kind: 'theirs', text: 'theirs' }]);
    expect(computeThreeWayMerge('base', 'ours', 'base')).toEqual([{ kind: 'ours', text: 'ours' }]);
    expect(computeThreeWayMerge('base', 'ours', 'theirs')).toEqual([
      { kind: 'conflict', ancestor: 'base', ours: 'ours', theirs: 'theirs' },
    ]);
    expect(applyMergeDecisions(computeThreeWayMerge('base', 'ours', 'theirs'), [
      { index: 0, choice: 'theirs' },
    ])).toBe('theirs');
  });

  test('merges independent line edits and preserves trailing newlines', () => {
    const regions = computeThreeWayMerge(
      'alpha\nbeta\ngamma\n',
      'ALPHA\nbeta\ngamma\n',
      'alpha\nbeta\nGAMMA\n',
    );
    expect(regions).toEqual([
      { kind: 'ours', text: 'ALPHA\n' },
      { kind: 'same', text: 'beta\n' },
      { kind: 'theirs', text: 'GAMMA\n' },
    ]);
    expect(applyMergeDecisions(regions, [])).toBe('ALPHA\nbeta\nGAMMA\n');
  });

  test('requires an explicit decision for every overlapping region', () => {
    const regions = computeThreeWayMerge(
      'alpha\nbeta\ngamma\n',
      'ours-a\nbeta\nours-g\n',
      'theirs-a\nbeta\ntheirs-g\n',
    );
    expect(regions.filter((region) => region.kind === 'conflict')).toHaveLength(2);
    expect(() => applyMergeDecisions(regions, [{ index: 0, choice: 'ours' }]))
      .toThrow(/has no decision/);
    expect(applyMergeDecisions(regions, [
      { index: 0, choice: 'ours' },
      { index: 2, choice: 'theirs' },
    ])).toBe('ours-a\nbeta\ntheirs-g\n');
  });
});

describe('range slice', () => {
  test('slices 1-based editor ranges', () => {
    expect(sliceDocumentRange('alpha\nbeta\ngamma', {
      startLine: 2,
      startColumn: 1,
      endLine: 2,
      endColumn: 5,
    })).toBe('beta');
  });
});

test('acknowledges only the captured editor revision and original branch', () => {
  const original = attachment(); addEditorContextAttachment(original);
  const replacement = addEditorContextAttachment(attachment({ text: 'new edit', localEditRevision: 4 }));
  const other = attachment({ id: 'other', threadKey: 'another-branch' }); addEditorContextAttachment(other);
  acknowledgeEditorContextAttachments([original]);
  expect(listEditorContextAttachments(runtimeKey, 'session-a')).toEqual([replacement]);
  acknowledgeEditorContextAttachments([replacement as EditorContextAttachment]);
  expect(listEditorContextAttachments(runtimeKey, 'session-a')).toEqual([]);
  expect(listEditorContextAttachments(runtimeKey, 'another-branch')).toEqual([other]);
});

test('keeps an old interactive selection as source evidence rather than overriding edited user text', () => {
  const text = projectEditorContextAttachments('Actually, use long hair', [attachment({
    kind: 'reference', ordinal: 1,
    reference: { ref: 'ui:hair@snapshot:short', title: 'Hairstyle', text: 'Short hair',
      source: { kind: 'ui', snapshotRef: 'ui:hair@snapshot:short', revisionRef: 'ui:hair@1' } },
  })]);
  expect(text.startsWith('Actually, use long hair')).toBe(true);
  expect(text).toContain('Short hair');
  expect(text).not.toContain('ui:hair@snapshot:short');
  expect(text).not.toContain('revisionRef');
  expect(text).not.toContain('Source:');
});
