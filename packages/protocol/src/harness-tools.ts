/**
 * Harness tool mutation attributes.
 *
 * Every harness tool name is mapped to its mutation kind and execution mode.
 * The recovery turn-coordinator uses `mutation` to decide whether a tool call
 * may produce unjournaled workspace changes (`process` or `unknown` → flag the
 * turn). The pi-host tool definitions use `executionMode` to request parallel
 * or sequential dispatch.
 *
 * Adding a new harness tool in a later phase MUST add its entry here so the
 * cross-check test in `packages/pi-host/test/harness-tools.test.ts` stays
 * exhaustive.
 */

export type HarnessToolMutation = 'none' | 'journaled' | 'process';

export interface HarnessToolMeta {
  mutation: HarnessToolMutation;
  executionMode: 'parallel' | 'sequential';
  /** Permission/audit action when mutation alone is not precise enough. */
  permissionAction?: 'read' | 'control';
}

export const HARNESS_TOOL_META: Readonly<Record<string, HarnessToolMeta>> = {
  read: { mutation: 'none', executionMode: 'parallel' },
  pi_docs: { mutation: 'none', executionMode: 'parallel' },
  find: { mutation: 'none', executionMode: 'parallel' },
  ls: { mutation: 'none', executionMode: 'parallel' },
  grep: { mutation: 'none', executionMode: 'parallel' },
  write: { mutation: 'journaled', executionMode: 'parallel' },
  edit: { mutation: 'journaled', executionMode: 'parallel' },
  apply_patch: { mutation: 'journaled', executionMode: 'parallel' },
  bash: { mutation: 'process', executionMode: 'sequential' },
  write_to_process: { mutation: 'process', executionMode: 'sequential' },
  kill_shell: { mutation: 'none', executionMode: 'sequential' },
  get_output: { mutation: 'none', executionMode: 'parallel' },
  diagnostics: { mutation: 'none', executionMode: 'parallel' },
  todo: { mutation: 'none', executionMode: 'sequential' },
  ask_question: { mutation: 'none', executionMode: 'parallel' },
  explore: { mutation: 'none', executionMode: 'parallel' },
  dispatch: { mutation: 'none', executionMode: 'parallel' },
  wait: { mutation: 'none', executionMode: 'sequential' },
  merge: { mutation: 'journaled', executionMode: 'sequential' },
  submit_code: { mutation: 'journaled', executionMode: 'parallel' },
  update: { mutation: 'journaled', executionMode: 'sequential' },
  kill: { mutation: 'none', executionMode: 'sequential' },
  threads: { mutation: 'none', executionMode: 'parallel' },
  send: { mutation: 'none', executionMode: 'parallel' },
  read_thread: { mutation: 'none', executionMode: 'parallel' },
  webfetch: { mutation: 'none', executionMode: 'parallel' },
  document_read: { mutation: 'none', executionMode: 'parallel' },
  websearch: { mutation: 'none', executionMode: 'parallel' },
  research_search: { mutation: 'none', executionMode: 'parallel' },
  research_decide: { mutation: 'none', executionMode: 'parallel' },
  materials: { mutation: 'none', executionMode: 'parallel' },
  recall: { mutation: 'none', executionMode: 'parallel' },
  related: { mutation: 'none', executionMode: 'parallel' },
  history: { mutation: 'none', executionMode: 'parallel' },
  symbols: { mutation: 'none', executionMode: 'parallel' },
  definition: { mutation: 'none', executionMode: 'parallel' },
  references: { mutation: 'none', executionMode: 'parallel' },
  experiment: { mutation: 'process', executionMode: 'sequential' },
  resources: { mutation: 'none', executionMode: 'parallel' },
  research_source: { mutation: 'none', executionMode: 'parallel' },
  settings_search: { mutation: 'none', executionMode: 'parallel', permissionAction: 'read' },
  settings_read: { mutation: 'none', executionMode: 'parallel', permissionAction: 'read' },
  settings_update: { mutation: 'none', executionMode: 'sequential', permissionAction: 'control' },
  settings_action: { mutation: 'none', executionMode: 'sequential', permissionAction: 'control' },
};

export const toolMutation = (name: string): HarnessToolMutation | 'unknown' => (
  HARNESS_TOOL_META[name]?.mutation ?? 'unknown'
);

export const toolExecutionMode = (name: string): 'parallel' | 'sequential' | 'unknown' => (
  HARNESS_TOOL_META[name]?.executionMode ?? 'unknown'
);
