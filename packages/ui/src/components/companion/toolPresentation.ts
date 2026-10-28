import type { Operation } from '@varin/protocol';

// Exact admitted names, not substring/argument/prose classification.
// Source owners: kernel ToolKind (tools.rs); extension-builtins browser/web/office declarations.
const categories: Readonly<Record<string, string>> = {
  file_read: 'T01', file_list: 'T01', file_search: 'T01', document_read: 'T01', office_read: 'T01',
  file_write: 'T02', file_edit: 'T02', office_write: 'T02',
  process_spawn: 'T03', process_write: 'T03', process_resize: 'T03',
  websearch: 'T04', webfetch: 'T04', research_search: 'T04', browser_tabs: 'T04', browser_open: 'T04', browser_read: 'T04', browser_act: 'T04', browser_files: 'T04',
  materials: 'T06', office_export: 'T06',
  process_inspect: 'T07', process_read: 'T07', recovery_points: 'T07', office_environment: 'T07', office_render: 'T07',
  code_retrieval: 'T08',
};
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
export function operationPresentation(operation: Operation): { state: string; tool: string } | null {
  if (operation.phase !== 'running' && operation.phase !== 'settling') return null;
  const intent = record(operation.intent);
  if (intent?.kind !== 'tool') return null;
  const call = record(intent.call), contract = record(intent.contract);
  // ToolIntent is admitted with a frozen contract; a decorative executor name is insufficient.
  const name = call?.name;
  if (typeof name !== 'string' || contract?.name !== name || typeof call?.schema_version !== 'string' || contract.schema_version !== call.schema_version) return null;
  const state = categories[name];
  return state ? { state, tool: name } : null;
}
