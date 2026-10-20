import type { ExploreProgressActivity, ExploreProgressPhase, ExploreQuerySourceState, ExploreSearchSnippet, ExploreToolProgress } from '@varin/protocol';
import type { ChatToolResultMessage } from './types';
import type { ChatToolExecutionState } from './types';

export const exploreRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const count = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= 0;
const phases = new Set(['starting', 'planning', 'collecting', 'selecting', 'following-up', 'finishing', 'complete', 'partial', 'empty', 'failed', 'unavailable', 'cancelled']);
const families = new Set(['lexical', 'graph', 'semantic', 'plan', 'followup', 'model']);
const statuses = new Set(['pending', 'running', 'ready', 'empty', 'unavailable', 'failed', 'cancelled', 'incomplete']);
const isSource = (value: unknown): value is ExploreQuerySourceState => {
  const row = exploreRecord(value);
  return !!row && typeof row.id === 'string' && typeof row.family === 'string' && families.has(row.family)
    && typeof row.status === 'string' && statuses.has(row.status)
    && (row.targets === undefined || Array.isArray(row.targets) && row.targets.every(target => typeof target === 'string'));
};
const isRange = (row: Record<string, unknown>): boolean => typeof row.path === 'string' && row.path.length > 0
  && count(row.startLine) && row.startLine >= 1 && count(row.endLine) && row.endLine >= row.startLine
  && typeof row.revision === 'string' && typeof row.source === 'string' && ['disk', 'surface-draft', 'working-branch'].includes(row.source);
const isActivity = (value: unknown): value is ExploreProgressActivity => {
  const row = exploreRecord(value);
  if (!row || !count(row.sequence) || typeof row.elapsedMs !== 'number' || !Number.isFinite(row.elapsedMs) || row.elapsedMs < 0) return false;
  if (row.kind === 'phase') return typeof row.phase === 'string' && phases.has(row.phase);
  if (row.kind === 'source') return isSource(row.source);
  return row.kind === 'read' && typeof row.viewId === 'string' && isRange(row);
};

export function parseExploreProgress(value: unknown): ExploreToolProgress | undefined {
  const row = exploreRecord(value);
  if (!row || typeof row.phase !== 'string' || !phases.has(row.phase) || typeof row.elapsedMs !== 'number' || !Number.isFinite(row.elapsedMs) || row.elapsedMs < 0
    || !count(row.receivedFiles) || !count(row.receivedSnippets) || !Array.isArray(row.sources) || !row.sources.every(isSource)
    || row.selectedViewIds !== undefined && (!Array.isArray(row.selectedViewIds) || !row.selectedViewIds.every(id => typeof id === 'string'))
    || !Array.isArray(row.activities) || !row.activities.every(isActivity)) return undefined;
  return row as unknown as ExploreToolProgress;
}

export type ExploreDisplayPhase = ExploreProgressPhase | 'preparing' | 'unknown' | 'invalid';
export function explorePresentation(execution?: ChatToolExecutionState, result?: ChatToolResultMessage, generating = false) {
  const final = Boolean(result || execution && execution.status !== 'running');
  const output = exploreRecord(execution?.result ?? execution?.partialResult);
  const details = exploreRecord(result?.details) ?? output;
  const ownProgress = parseExploreProgress(details?.progress);
  const progress = ownProgress
    ?? parseExploreProgress(exploreRecord(exploreRecord(execution?.partialResult)?.details)?.progress);
  const rawSnippets = details?.snippets;
  const validSnippets = Array.isArray(rawSnippets) && rawSnippets.every(value => {
    const row = exploreRecord(value);
    return row && typeof row.path === 'string' && count(row.startLine) && count(row.endLine) && typeof row.content === 'string';
  });
  const snippets = validSnippets ? rawSnippets.map(value => {
    const row = value as Record<string, unknown>;
    return { ...row, text: row.content, why: typeof row.why === 'string' ? row.why : '',
      source: row.source ?? (exploreRecord(details?.source)?.mode === 'fixed_branch' ? 'working-branch' : 'disk') } as unknown as ExploreSearchSnippet;
  }) : undefined;
  const invalid = (rawSnippets !== undefined && !validSnippets) || (details?.progress !== undefined && !ownProgress);
  let phase: ExploreDisplayPhase;
  if (progress?.phase === 'cancelled' || result?.status === 'cancelled' || execution?.status === 'cancelled') phase = 'cancelled';
  else if (details?.status === 'unavailable') phase = 'unavailable';
  else if (result?.isError || execution?.status === 'error' || typeof details?.error === 'string') phase = 'failed';
  else if (result?.status === 'unknown' || execution?.status === 'unknown') phase = 'unknown';
  else if (invalid) phase = 'invalid';
  else if (final) phase = details?.status === 'partial' ? 'partial' : snippets ? snippets.length ? 'complete' : 'empty' : 'unknown';
  else if (execution?.status === 'running') phase = progress && ['complete', 'partial', 'empty'].includes(progress.phase) ? 'finishing' : progress?.phase ?? 'starting';
  else phase = generating ? 'preparing' : 'unknown';
  const running = execution?.status === 'running' && !['complete', 'partial', 'empty', 'failed', 'unavailable', 'cancelled'].includes(phase);
  return { phase, running, final, details, progress, snippets,
    returnedFiles: snippets ? new Set(snippets.map(snippet => snippet.path)).size : undefined };
}
