import { expect, it, vi } from 'vitest';
import { kernelDiagnosticReader } from './kernel-diagnostics.js';

it('preserves split structured transport diagnostics and discards arbitrary stderr', () => {
  const emit = vi.fn(); const read = kernelDiagnosticReader(emit);
  const diagnostic = { stage: 'control-read', kind: 'InvalidData', osError: null, reason: 'invalid control JSON' };
  const line = `[VarinKernelTransport] ${JSON.stringify(diagnostic)}\r\n`;
  read('unstructured source text and credential must stay private\n');
  read(line.slice(0, 24)); read(line.slice(24, 70)); read(line.slice(70));
  read(`[VarinKernelTransport] ${JSON.stringify({ ...diagnostic, source: 'private file body' })}\n`);
  read('private'.repeat(200)); read(line); // A suffix of an oversized line is not a new record.
  read(line);
  expect(emit.mock.calls).toEqual([[diagnostic], [diagnostic]]);
});
