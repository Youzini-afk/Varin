import { isDeepStrictEqual } from 'node:util';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { LaunchSource } from './protocol.generated.js';
import { normalizeResourceId } from '../recovery/journal-files.js';
import type { SourcePathMap } from '../harness/working-state/source-paths.js';
export { mapSourcePath, mapSourceResult, type SourcePathMap } from '../harness/working-state/source-paths.js';

const join = (left: string, right: string) => [left, right].filter(Boolean).join('/');

/** Catalog's original handoffs retain every scope, including nested dispatches
 * and continuations. Navigation folders and names are never coordinate evidence. */
export async function sourcePathMap(runtime: Pick<AgentRuntimeClient, 'launch' | 'childExecutionForRun'>, sender: { runId: string; source: LaunchSource },
  receiver: { runId: string; source: LaunchSource }, signal: AbortSignal): Promise<SourcePathMap> {
  const origin = async (selected: typeof sender) => {
    let { runId, source } = selected;
    let prefix = '';
    const seen = new Set<string>();
    for (;;) {
      signal.throwIfAborted();
      if (seen.has(runId)) throw new Error('Source handoff contains a cycle');
      seen.add(runId);
      const execution = await runtime.childExecutionForRun(runId, signal);
      const handoff = execution?.source && execution.source.kind !== 'absent' ? execution.source.handoff : null;
      if (handoff) {
        prefix = join(handoff.source_path ?? '', prefix);
        source = handoff.source;
        runId = handoff.source_run_id ?? execution!.parent_run_id;
      } else if (execution && execution.trigger.kind !== 'dispatch' && execution.source_basis) {
        if (execution.source_basis.kind === 'refreshed') {
          runId = execution.source_basis.incoming.run_id;
          source = execution.source_basis.incoming.source;
        } else {
          runId = execution.trigger.previous_run_id;
          const launch = await runtime.launch(runId, signal);
          if (!launch?.selection.source) throw new Error('Original continuation source is unavailable');
          source = launch.selection.source;
        }
      } else return { source, runId: source.environment_run_id ?? runId, prefix };
    }
  };
  const [a, b] = await Promise.all([origin(sender), origin(receiver)]);
  const sameRoot = isDeepStrictEqual(a.source.resource_owner, b.source.resource_owner)
    && a.source.workspace_id === b.source.workspace_id
    && a.source.execution_workspace_id === b.source.execution_workspace_id
    && (a.source.mode === 'live_root' && b.source.mode === 'live_root'
      ? isDeepStrictEqual(a.source.live_root, b.source.live_root)
      : a.source.mode === b.source.mode && a.source.branch_id === b.source.branch_id
        && a.source.revision === b.source.revision && (a.source.mode === 'fixed_branch' || a.runId === b.runId));
  if (!sameRoot) throw Object.assign(new Error('These Agents have no common source coordinate root'), { code: 'baseline_unavailable' });
  for (const prefix of [a.prefix, b.prefix]) if (prefix) normalizeResourceId(prefix);
  if (a.prefix === b.prefix) return { from: '', to: '' };
  if (!b.prefix || a.prefix.startsWith(`${b.prefix}/`)) return { from: '', to: b.prefix ? a.prefix.slice(b.prefix.length + 1) : a.prefix };
  if (!a.prefix || b.prefix.startsWith(`${a.prefix}/`)) return { from: a.prefix ? b.prefix.slice(a.prefix.length + 1) : b.prefix, to: '' };
  throw Object.assign(new Error('The selected source directories are disjoint; their files cannot be exchanged by relative path'), { code: 'source_scope_mismatch' });
}
