import { expect, it } from 'vitest';
import { buildThreeWayMergePlan, mergeText3Way, planThreeWayPath } from './three-way-merge.js';
import type { RecoveryState } from './types.js';

const file = (objectHash: string, mode = 0o644): RecoveryState => ({ kind: 'regular-file', objectHash, byteLength: 10, mode });
const missing: RecoveryState = { kind: 'missing' };

it.each([
  ['same change', 'changed', 'changed', 'identical'],
  ['parent unchanged', 'base', 'child', 'apply-child'],
  ['child unchanged', 'parent', 'base', 'keep-parent'],
])('plans %s without needing file bodies', async (_label, parent, child, decision) => {
  expect(await planThreeWayPath({ path: 'note', baseState: file('base'), parentState: file(parent!), childState: file(child!),
    readContent: async () => { throw new Error('Unchanged content must not require a read'); },
  })).toMatchObject({ decision });
});

it('merges independent text and mode edits while retaining mixed line endings and a missing final newline', async () => {
  const contents: Record<string, string> = { base: 'one\r\ntwo\nthree', parent: 'parent\r\ntwo\nthree', child: 'one\r\ntwo\nchild' };
  expect(await planThreeWayPath({ path: 'script.sh', baseState: file('base'), parentState: file('parent', 0o755), childState: file('child'),
    readContent: async state => state.kind === 'regular-file' ? Buffer.from(contents[state.objectHash]!) : null,
  })).toMatchObject({ decision: 'merge-clean', mergedMode: 0o755, mergedText: 'parent\r\ntwo\nchild' });
});

it('merges distant edits in a ten-thousand-line file', () => {
  // Guard the large-file regression through the merge result, not LCS indices or
  // a particular diff implementation. Native memory/time budgets belong to profiling.
  const base = Array.from({ length: 10_000 }, (_, index) => `line-${index}`);
  const parent = [...base], child = [...base], expected = [...base];
  parent[123] = expected[123] = 'parent edit';
  child[9_876] = expected[9_876] = 'child edit';
  expect(mergeText3Way(base.join('\n'), parent.join('\n'), child.join('\n')))
    .toEqual({ clean: true, text: expected.join('\n') });
});

it.each([
  ['line1\nline2\nline3', 'line1\nparent2\nline3', 'line1\nchild2\nline3', 'parent2', 'child2'],
  ['A\nB\nC\nD', 'P1\nP2\nC\nD', 'A\nC1\nC2\nD', 'P1\nP2\nC', 'A\nC1\nC2'],
])('keeps both conflicting edits in the result', (base, parent, child, parentConflict, childConflict) => {
  const merged = mergeText3Way(base!, parent!, child!);
  expect(merged.clean).toBe(false);
  expect(merged.text).toContain(`<<<<<<< parent\n${parentConflict}\n=======\n${childConflict}\n>>>>>>> child`);
});

it.each([
  ['null bytes', Buffer.from([0, 1, 2])],
  ['invalid UTF-8', Buffer.from([0x80, 0x41])],
  ['late null byte', Buffer.concat([Buffer.alloc(9000, 65), Buffer.from([0])])],
] as const)('does not text-merge binary edits containing %s', async (_label, bytes) => {
  expect(await planThreeWayPath({ path: 'binary', baseState: file('base'), parentState: file('parent'), childState: file('child'),
    readContent: async () => bytes,
  })).toMatchObject({ decision: 'conflict', isText: false });
});

it('preserves independent native attributes and child binary content without reading bodies', async () => {
  const native = { uid: 0, gid: 0, created: null, modified: { seconds: 1, nanos: 0 }, backup: null,
    windowsAttributes: 0, bsdFlags: 0, security: null, reparseData: null, xattrs: {} };
  const base = { kind: 'regular-file' as const, objectHash: 'base', byteLength: 2, mode: 0o644, native };
  const parent = { ...base, native: { ...native, xattrs: { dXNlci5w: [1] } } };
  const child = { ...base, objectHash: 'child', native: { ...native, modified: { seconds: 2, nanos: 0 }, xattrs: { dXNlci5j: [2] } } };
  expect(await planThreeWayPath({ path: 'binary', baseState: base, parentState: parent, childState: child,
    readContent: async () => { throw new Error('Metadata merge must not read binary content'); },
  })).toMatchObject({ decision: 'merge-clean', mergedState: { ...child, native: { ...child.native, xattrs: { dXNlci5w: [1], dXNlci5j: [2] } } } });

  // Equal bodies do not erase conflicting attributes.
  expect(await planThreeWayPath({ path: 'binary', baseState: base, parentState: parent,
    childState: { ...parent, native: { ...native, xattrs: { dXNlci5w: [2] } } }, readContent: async () => null,
  })).toMatchObject({ decision: 'conflict' });
});

it('reports applied paths separately from delete/modify conflicts', async () => {
  const plan = await buildThreeWayMergePlan({ operationId: 'op', workspaceId: 'ws', threadId: 'thread', resultRevision: 1,
    allPaths: ['clean.txt', 'conflict.txt'],
    baseState: { 'clean.txt': file('base'), 'conflict.txt': file('base') },
    parentState: { 'clean.txt': file('base'), 'conflict.txt': file('parent') },
    childState: { 'clean.txt': file('child'), 'conflict.txt': missing },
    readContent: async () => { throw new Error('Structural decisions must not require bodies'); },
  });
  expect(plan).toMatchObject({ clean: false, appliedPaths: ['clean.txt'], conflictPaths: ['conflict.txt'], diffStats: { files: 2 } });
});
