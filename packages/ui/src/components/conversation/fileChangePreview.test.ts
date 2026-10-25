import { expect, it } from 'vitest';
import { fileChangePhase } from './fileChangePreview';
import type { ChatToolResultMessage } from './types';

const result = (details?: ChatToolResultMessage['details'], status: ChatToolResultMessage['status'] = 'success'): ChatToolResultMessage => ({
  role: 'toolResult', toolCallId: 'original-call', toolName: 'file_write', timestamp: 0, isError: false,
  content: [{ type: 'text', text: 'Operation completed' }], details, status,
});
it('requires a mutation receipt before presenting proposed file contents as applied', () => {
  expect(fileChangePhase(undefined, result(), false)).toBe('preview');
  expect(fileChangePhase(undefined, result(undefined, 'background'), false)).toBe('preview');
  expect(fileChangePhase({ toolCallId: 'call', name: 'file_write', args: {}, status: 'success' }, undefined, false)).toBe('preview');
  expect(fileChangePhase(undefined, result({ status: 'applied' }), false)).toBe('applied');
});
it('keeps dirty editor edits, committed branches and failed per-file mutations distinct', () => {
  expect(fileChangePhase(undefined, result({ mutation: { status: 'applied', results: [{ path: 'a.ts', status: 'applied', target: 'surface' }] } }), false, 'a.ts')).toBe('draft');
  expect(fileChangePhase(undefined, result({ mutation: { status: 'committed' } }), false)).toBe('branch');
  expect(fileChangePhase(undefined, result({ mutation: { status: 'partial', results: [{ path: 'a.ts', status: 'conflict' }] } }), false, 'a.ts')).toBe('failed');
  expect(fileChangePhase(undefined, result({ status: 'applied' }, 'unknown'), false)).toBe('preview');
});

import { createFileChangeProjector, fileChangeStreamLength, paceFileChangeCall, projectFileChanges } from './fileChangePreview';
import type { ChatToolCall } from './types';

const edit = (edits: unknown[], path = 'src/login.ts'): ChatToolCall => ({ type: 'toolCall', id: 'edit', name: 'file_edit', arguments: { path, edits } as ChatToolCall['arguments'] });
const rows = (call: ChatToolCall, generating: boolean) => projectFileChanges(call, generating)[0]!.lines
  .map(line => `${line.key}:${line.kind}${line.pending ? '*' : ''}${line.ahead ? '~' : ''}${line.typed !== undefined ? `@${line.typed}` : ''}:${line.text}`);

it('keeps row identities while an edit streams and when it settles', () => {
  const oldText = 'const a = 1;\nconst b = 2;\nconst c = 3;\n';
  // Old text still arriving: proposed removals, the last line being written.
  expect(rows(edit([{ oldText: 'const a = 1;\nconst b' }]), true)).toEqual(['e0o0:remove:const a = 1;', 'e0o1:remove*:const b']);
  // New text arriving: decided part, then a line written over an old one, then undecided old lines.
  expect(rows(edit([{ oldText, newText: 'const a = 1;\nconst b = 20;\nconst c' }]), true)).toEqual([
    'e0o0:context:const a = 1;', 'e0n1:add:const b = 20;', 'e0o2:context*@7:const c = 3;', 'e0o1:remove~:const b = 2;',
  ]);
  // Settled: the same identities, in diff order.
  expect(rows(edit([{ oldText, newText: 'const a = 1;\nconst b = 20;\nconst c = 3;\n' }]), false)).toEqual([
    'e0o0:context:const a = 1;', 'e0o1:remove:const b = 2;', 'e0n1:add:const b = 20;', 'e0o2:context:const c = 3;',
  ]);
});

it('does not write over an old line on indentation alone', () => {
  const oldText = 'f() {\n  a();\n  b();\n}\n';
  expect(rows(edit([{ oldText, newText: 'f() {\n  ' }]), true)).toEqual([
    'e0o0:context:f() {', 'e0n1:add*:  ', 'e0o1:remove~:  a();', 'e0o2:remove~:  b();', 'e0o3:remove~:}',
  ]);
  expect(rows(edit([{ oldText, newText: 'f() {\n  b' }]), true)).toContain('e0o2:context*@3:  b();');
});

it('marks the line being written in whole-file writes and patches', () => {
  const write: ChatToolCall = { type: 'toolCall', id: 'w', name: 'file_write', arguments: { path: 'a.ts', content: 'one\ntw' } };
  expect(rows(write, true)).toEqual(['w0:add:one', 'w1:add*:tw']);
  expect(rows(write, false)).toEqual(['w0:add:one', 'w1:add:tw']);
  const patch: ChatToolCall = { type: 'toolCall', id: 'p', name: 'apply_patch', arguments: { patch: '*** Begin Patch\n*** Update File: a.ts\n@@\n-old\n+ne' } };
  expect(rows(patch, true)).toEqual(['p2:hunk:@@', 'p3:remove:old', 'p4:add*:ne']);
});

it('paces a call in writing order without showing new text before its old text', () => {
  const call = edit([{ oldText: 'abc\n', newText: 'xyz\n' }, { oldText: 'def\n', newText: '' }]);
  expect(fileChangeStreamLength(call)).toBe(12);
  expect(paceFileChangeCall(call, 2).arguments).toEqual({ path: 'src/login.ts', edits: [{ oldText: 'ab' }] });
  expect(paceFileChangeCall(call, 6).arguments).toEqual({ path: 'src/login.ts', edits: [{ oldText: 'abc\n', newText: 'xy' }] });
  expect(paceFileChangeCall(call, 10).arguments).toEqual({ path: 'src/login.ts', edits: [{ oldText: 'abc\n', newText: 'xyz\n' }, { oldText: 'de' }] });
  expect(paceFileChangeCall(call, 12)).toBe(call);
});

it('retains complete write rows and matches the full projection through edits and rewinds', () => {
  const project = createFileChangeProjector();
  const write = (content: string): ChatToolCall => ({ type: 'toolCall', id: 'write', name: 'file_write', arguments: { path: 'a.ts', content } });
  const first = project(write('first\nsec'), true);
  const next = project(write('first\nsecond'), true);
  expect(next[0]!.lines[0]).toBe(first[0]!.lines[0]);
  for (const content of ['first\nsecond\n', 'first\nsecond\nthird', 'replacement', 'replacement\r\n中文']) {
    expect(project(write(content), true)).toEqual(projectFileChanges(write(content), true));
    expect(project(write(content), false)).toEqual(projectFileChanges(write(content), false));
  }
  const oldText = 'first\nold\nlast\n';
  for (const newText of ['f', 'first\n', 'first\nne', 'first\nnew\nlast\n', 'replacement']) {
    const call = edit([{ oldText, newText }]);
    expect(project(call, true)).toEqual(projectFileChanges(call, true));
    expect(project(call, false)).toEqual(projectFileChanges(call, false));
  }
});
