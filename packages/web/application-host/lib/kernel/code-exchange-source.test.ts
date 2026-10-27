import { expect, it } from 'vitest';
import { sameWritableSource, sameSharedWritableSource } from './code-exchange.js';
import type { LaunchSource } from './protocol.generated.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import { sourcePathMap } from './source-path-map.js';
import {mapSourcePath}from '../harness/working-state/source-paths.js';

it('maps directory metadata to the selected source root without admitting sibling attributes',()=>{
  expect(mapSourcePath('.',{from:'',to:'project/src'})).toBe('project/src');
  expect(mapSourcePath('project/src',{from:'project/src',to:''})).toBe('.');
  expect(mapSourcePath('.',{from:'project/src',to:''})).toBeNull();
  expect(mapSourcePath('.',{from:'',to:''})).toBe('.');
});

const live = (rootId: string, canonicalRoot = 'D:/work'): LaunchSource => ({ workspace_id: 'workspace', execution_workspace_id: 'workspace',
  branch_id: null, revision: null, mode: 'live_root', live_root: { hostId: 'host', rootId, canonicalRoot }, resource_owner: { kind: 'local' } });
const materialized = (environment: string | null, branch = 'branch', revision = 3): LaunchSource => ({ workspace_id: 'workspace', execution_workspace_id: 'workspace',
  branch_id: branch, revision, mode: 'materialized', live_root: null, resource_owner: { kind: 'local' }, ...(environment ? { environment_run_id: environment } : {}) });
const fixed = (): LaunchSource => ({ ...materialized(null), mode: 'fixed_branch' });

it('recognizes the same actual writable directory and keeps every other pairing a real exchange', () => {
  // A shared child of a live-root parent uses the parent's registered root.
  expect(sameWritableSource({ runId: 'parent', source: live('root') }, { runId: 'child', source: live('root') })).toBe(true);
  expect(sameWritableSource({ runId: 'parent', source: live('root') }, { runId: 'child', source: live('other-root') })).toBe(false);
  expect(sameWritableSource({ runId: 'parent', source: live('root') }, { runId: 'child', source: live('root', 'D:/elsewhere') })).toBe(false);
  // A shared child of a materialized parent records the parent's Run as its execution environment.
  expect(sameWritableSource({ runId: 'parent', source: materialized(null) }, { runId: 'child', source: materialized('parent') })).toBe(true);
  // An isolated child owns its own execution directory, even from the same baseline.
  expect(sameWritableSource({ runId: 'parent', source: materialized(null) }, { runId: 'child', source: materialized(null) })).toBe(false);
  expect(sameWritableSource({ runId: 'parent', source: materialized(null) }, { runId: 'child', source: materialized('parent', 'branch', 4) })).toBe(false);
  // Immutable revisions and different resource owners are never one writable source.
  expect(sameWritableSource({ runId: 'a', source: fixed() }, { runId: 'b', source: fixed() })).toBe(false);
  expect(sameWritableSource({ runId: 'parent', source: live('root') }, { runId: 'child', source: { ...live('root'), resource_owner: { kind: 'managed_host', hostId: 'h', connectionId: 'c', endpointIdentity: 'e' } } })).toBe(false);
});

it('retains scoped coordinates through nested dispatch, sourceAgent selection and continuation', async () => {
  const original = live('root');
  const sources: Record<string, LaunchSource> = { parent: original, child: materialized(null, 'child'), nested: materialized(null, 'nested'),
    continued: materialized(null, 'continued'), sibling: materialized(null, 'sibling') };
  const executions = {
    child: { parent_run_id: 'parent', source: { kind: 'ready', handoff: { source: original, source_path: 'project' } } },
    nested: { parent_run_id: 'parent', source: { kind: 'ready', handoff: { source: sources.child, source_run_id: 'child', source_path: 'src' } } },
    continued: { trigger: { kind: 'user_continuation', previous_run_id: 'nested' }, source_basis: { source: sources.nested } },
    sibling: { parent_run_id: 'parent', source: { kind: 'ready', handoff: { source: original, source_path: 'elsewhere' } } },
  };
  const runtime = { childExecutionForRun: async (runId: string) => executions[runId as keyof typeof executions] ?? null,
    launch: async (runId: string) => ({ selection: { source: sources[runId] } }) } as unknown as AgentRuntimeClient;
  const selected = (runId: string) => ({ runId, source: sources[runId]! });
  const signal = new AbortController().signal;
  expect(await sourcePathMap(runtime, selected('continued'), selected('parent'), signal)).toEqual({ from: '', to: 'project/src' });
  expect(await sourcePathMap(runtime, selected('parent'), selected('continued'), signal)).toEqual({ from: 'project/src', to: '' });
  expect(await sourcePathMap(runtime, selected('continued'), selected('child'), signal)).toEqual({ from: '', to: 'src' });
  await expect(sourcePathMap(runtime, selected('continued'), selected('sibling'), signal)).rejects.toMatchObject({ code: 'source_scope_mismatch' });
});

it('recognizes a live subroot shared from a deferred private source without treating independent copies as shared', async () => {
  const source = materialized(null, 'private-source');
  const scoped = live('scoped-root', 'D:/managed/private/project');
  const runtime = { childExecutionForRun: async (runId: string) => runId === 'scoped'
    ? { source: { kind: 'shared', handoff: { source, source_path: 'project' } }, parent_run_id: 'private' }
    : null } as unknown as AgentRuntimeClient;
  const signal = new AbortController().signal;
  expect(await sameSharedWritableSource(runtime, { runId: 'scoped', source: scoped }, { runId: 'private', source }, signal)).toBe(true);
  expect(await sameSharedWritableSource(runtime, { runId: 'separate', source: materialized(null, 'separate-source') }, { runId: 'private', source }, signal)).toBe(false);
});
