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
