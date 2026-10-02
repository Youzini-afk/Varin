import { describe, expect, test } from 'bun:test';
import type { PiToolCall, PiToolResultMessage } from '@varin/protocol';
import { fileChangePhase, fileChangeTargets, projectFileChanges } from './fileChangePreview';

const call = (name: string, args: PiToolCall['arguments']): PiToolCall => ({ type: 'toolCall', id: 'call', name, arguments: args });

describe('file change projection', () => {
  test('collects summary targets across rename/delete without projecting file contents', () => {
    const patch = '*** Begin Patch\r\n*** Update File: old.ts\r\n*** Move to: new.ts\r\n-old\r\n+new\r\n*** Delete File: gone.ts\r\n*** End Patch\r\n*** Add File: outside.txt';
    expect(fileChangeTargets(call('apply_patch', { patch }))).toEqual([
      { path: 'new.ts', operation: 'update' }, { path: 'gone.ts', operation: 'delete' },
    ]);
    expect(fileChangeTargets(call('write', { path: 'whole.ts', content: 'a\nb\nc' }))).toEqual([{ path: 'whole.ts', operation: 'write' }]);
    expect(fileChangeTargets(call('read', { path: 'whole.ts' }))).toEqual([]);
  });

  test('streams incomplete multi-file patches without inventing paths, context numbers or deleted content', () => {
    const patch = '*** Begin Patch\n*** Update File: D:\\work\\a.ts\n@@ existing\n old\n-remove\n+add';
    const first = projectFileChanges(call('apply_patch', { patch }), true);
    expect(first[0]?.path).toBe('D:\\work\\a.ts');
    expect(first[0]?.counts).toEqual({ added: 1, removed: 1 });
    expect(first[0]?.lines.at(-1)).toEqual({ kind: 'add', text: 'add' });
    const next = projectFileChanges(call('apply_patch', { patch: patch + 'ition\n*** Add File: new' }), true);
    expect(next.length).toBe(1);
    expect(next[0]?.lines.at(-1)?.text).toBe('addition');
    const done = projectFileChanges(call('apply_patch', { patch: patch + 'ition\n*** Add File: new.txt\n+hello\n+\n*** Delete File: old.txt\n*** End Patch' }));
    expect(done.map(file => file.path)).toEqual(['D:\\work\\a.ts', 'new.txt', 'old.txt']);
    expect(done[1]?.counts).toEqual({ added: 2, removed: 0 });
    expect(done[2]?.counts).toBeUndefined();
    expect(done[2]?.lines).toEqual([]);
  });

  test('supports native Pi multi-edit, empty replacements and whole-file writes without fabricated removal counts', () => {
    const edit = projectFileChanges(call('edit', { path: 'a.ts', edits: [
      { oldText: 'context\nold\n', newText: 'context\nnew\n' },
      { oldText: 'deleted\n', newText: '' },
    ] }))[0]!;
    expect(edit.counts).toEqual({ added: 1, removed: 2 });
    expect(edit.lines[0]).toEqual({ kind: 'context', text: 'context' });
    const write = projectFileChanges(call('write', { path: 'a.ts', content: 'first\r\nsecond\n' }))[0]!;
    expect(write.lines.map(line => line.text)).toEqual(['first', 'second']);
    expect(write.counts).toBeUndefined();
    expect(projectFileChanges(call('write', { path: 'empty', content: '' }))[0]?.lines).toEqual([]);
    expect(projectFileChanges(call('bash', { command: 'echo abc > file' }))).toEqual([]);
  });

  test('distinguishes generation, execution, missing results and real mutation destinations/failures', () => {
    expect(fileChangePhase(undefined, undefined, true)).toBe('generating');
    expect(fileChangePhase(undefined, undefined, false)).toBe('preview');
    const running = { name: 'edit', toolCallId: 'call', status: 'running' as const, args: {} };
    expect(fileChangePhase(running, undefined, false)).toBe('applying');
    const result: PiToolResultMessage = { toolCallId: 'call', toolName: 'edit', role: 'toolResult', timestamp: 1, isError: false, content: [], details: { applied: false } };
    expect(fileChangePhase(undefined, result, false)).toBe('failed');
    result.details = { mutation: { status: 'committed' } };
    expect(fileChangePhase(undefined, result, false)).toBe('branch');
    result.details = { mutation: { status: 'partial', results: [
      { path: 'a.ts', target: 'surface', status: 'applied' },
      { path: 'b.ts', target: 'disk', status: 'conflict' },
      { path: 'c.ts', target: 'disk', status: 'compensated' },
    ] } };
    expect(fileChangePhase(undefined, result, false)).toBe('partial');
    expect(fileChangePhase(undefined, result, false, 'a.ts')).toBe('draft');
    expect(fileChangePhase(undefined, result, false, 'b.ts')).toBe('failed');
    expect(fileChangePhase(undefined, result, false, 'c.ts')).toBe('failed');
    expect(fileChangePhase({ ...running, status: 'success', result: { details: result.details } }, undefined, false, 'a.ts')).toBe('draft');
  });
});
