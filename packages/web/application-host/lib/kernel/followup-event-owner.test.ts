import { describe, expect, it, vi } from 'vitest';
import { createFollowupEventOwner } from './followup-event-owner.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { PluginEventSources } from '../extensions/event-sources.js';

const source = { extensionId: 'mail', sourceId: 'received', connectionId: 'personal', accountId: 'alice@inbox' };
const origin = { kind: 'model_step', request_id: 'original-step' };
const context = { run_id: 'run', operation_id: 'operation', origin };
function fixture() {
  const facts = { run: { id: 'run', principal_id: 'alice', cancel_requested: false },
    operation: { id: 'operation', run_id: 'run', phase: 'queued', cancel_requested: false,
      intent: { kind: 'tool', origin, call: { name: 'follow_up', arguments: { action: 'arrange', source } } } } };
  const runtime = { run: vi.fn(async () => facts.run), operation: vi.fn(async () => facts.operation) };
  const sources = { discover: vi.fn(async () => []), validateArrangement: vi.fn(async () => {}) };
  const owner = createFollowupEventOwner(runtime as unknown as AgentRuntimeClient, sources as unknown as PluginEventSources);
  return { facts, runtime, sources, owner, query: { kind: 'followup_event_source_validate', context, source, filter: {} }, signal: new AbortController().signal };
}
describe('original follow-up source owner', () => {
  it('discovers read-only sources without an Operation row and ignores caller-selected principal', async () => {
    const f = fixture(); f.runtime.operation.mockRejectedValue(new Error('read-only call has no operation'));
    await expect(f.owner({ kind: 'followup_event_sources', context, principalId: 'bob' }, f.signal)).resolves.toEqual([]);
    expect(f.sources.discover).toHaveBeenCalledWith('alice', f.signal);
    expect(f.runtime.operation).not.toHaveBeenCalled();
  });
  it.each(['accepted', 'preparing', 'queued', 'running'])('validates the frozen arrange call while %s', async phase => {
    const f = fixture(); f.facts.operation.phase = phase;
    await expect(f.owner(f.query, f.signal)).resolves.toEqual({});
    expect(f.sources.validateArrangement).toHaveBeenCalledWith('alice', source, {}, f.signal);
    expect(f.runtime.operation).toHaveBeenCalledTimes(2);
  });
  it.each(['settling', 'terminal'])('rejects an ended invocation in %s', async phase => {
    const f = fixture(); f.facts.operation.phase = phase;
    await expect(f.owner(f.query, f.signal)).rejects.toThrow('no longer active');
    expect(f.sources.validateArrangement).not.toHaveBeenCalled();
  });
  it('rejects a replaced account or filter instead of widening the frozen call', async () => {
    const f = fixture();
    await expect(f.owner({ ...f.query, source: { ...source, accountId: 'bob@inbox' } }, f.signal)).rejects.toThrow('differs');
    await expect(f.owner({ ...f.query, filter: { folder: 'all' } }, f.signal)).rejects.toThrow('differs');
    expect(f.sources.validateArrangement).not.toHaveBeenCalled();
  });
  it('checks cancellation again after discovery and validation return', async () => {
    const f = fixture(); f.sources.validateArrangement.mockImplementation(async () => { f.facts.operation.cancel_requested = true; });
    await expect(f.owner(f.query, f.signal)).rejects.toThrow('no longer active');
    f.sources.discover.mockImplementation(async () => { f.facts.run.cancel_requested = true; return []; });
    await expect(f.owner({ kind: 'followup_event_sources', context }, f.signal)).rejects.toThrow('Run changed');
  });
  it('does not enter a source owner after abort', async () => {
    const f = fixture(); const controller = new AbortController(); controller.abort();
    await expect(f.owner(f.query, controller.signal)).rejects.toThrow();
    expect(f.runtime.run).not.toHaveBeenCalled();
    expect(f.sources.validateArrangement).not.toHaveBeenCalled();
  });
});
