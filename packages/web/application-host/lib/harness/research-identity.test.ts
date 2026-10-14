import { describe, expect, it } from 'vitest';
import type { KernelRecordResult } from '../kernel/protocol.generated.js';
import { mayAccessResearch, requireResearchOwner, researchMaintenanceCaller, researchOwner } from './research-identity.js';
import { nativeResearchCaller, nativeResearchReader } from './native-research.fixture.js';

const caller = nativeResearchCaller({ rootThreadId: 'root', threadId: 'child', operationId: 'original-operation' });
const record = (): KernelRecordResult => ({ recordId: 'experiment.attempt:original', recordType: 'experiment.attempt', workspaceId: caller.workspaceId,
  threadId: caller.owner.threadId, runId: caller.owner.runId, recordRevision: 1, state: 'queued', references: [], createdAt: 1, updatedAt: 1,
  payloadJson: JSON.stringify({ researchOwner: caller.owner, executionWorkspaceId: caller.executionWorkspaceId, workspaceScope: ['src'] }) });

describe('native research provenance', () => {
  it('retains its original operation and source across maintenance while separating reading from control', () => {
    const stored = record();
    const reader = nativeResearchReader({ ...caller, threadId: 'sibling', readThreadIds: ['child', 'sibling'], controlThreadIds: ['sibling'] });
    expect(mayAccessResearch(reader, stored)).toBe(true);
    expect(mayAccessResearch(reader, stored, true)).toBe(false);
    expect(() => requireResearchOwner(reader)).toThrow(/read scope/);
    expect(mayAccessResearch(nativeResearchCaller({ rootThreadId: 'other', readThreadIds: ['child'] }), stored)).toBe(false);
    const maintenance = researchMaintenanceCaller(caller.workspaceId, stored);
    expect(maintenance.owner).toEqual(caller.owner);
    expect(maintenance.workspaceScope).toEqual(['src']);
    expect(mayAccessResearch(maintenance, stored, true)).toBe(true);
  });

  it('rejects legacy, malformed, reader and mismatched stored provenance without replacing it', () => {
    for (const update of [
      { runtime: 'pi', rootSessionId: 'old-session' },
      { ...caller.owner, branchId: '' },
      { ...caller.owner, actor: { kind: 'reader' } },
      { ...caller.owner, actor: { kind: 'tool', callId: 'call', toolName: 'research_submit', schemaVersion: '1', origin: {} } },
      { ...caller.owner, source: { ...caller.owner.source, workspace_id: 'foreign' } },
      { ...caller.owner, sessionId: 'old-session' },
    ]) {
      const stored = { ...record(), payloadJson: JSON.stringify({ researchOwner: update, executionWorkspaceId: caller.executionWorkspaceId }) };
      const original = structuredClone(stored);
      expect(() => researchOwner(stored)).toThrow(/original runtime owner/);
      expect(() => researchMaintenanceCaller(caller.workspaceId, stored)).toThrow();
      expect(stored).toEqual(original);
    }
    expect(() => researchOwner({ ...record(), threadId: 'forged' })).toThrow();
    expect(() => researchOwner({ ...record(), sessionId: 'old-session' })).toThrow();
  });
});
