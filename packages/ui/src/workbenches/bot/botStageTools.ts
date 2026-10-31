import type { BotToolProp } from './botPresentation';

/**
 * Which prop her own round holds for a tool (docs/design/varin-figure.md). Names are matched exactly
 * as the runtime admits them (kernel ToolKind, built-in extensions), with the prefixes those owners
 * reserve; never arguments or prose. Any other real tool (MCP, extensions) is 'other'. 'team' is
 * coordinating members: the team on the ledge already shows it, so she holds no prop.
 */
export type BotToolKind = BotToolProp | 'team';

const EXACT: Readonly<Record<string, BotToolKind>> = {
  file_read: 'read', document_read: 'read', office_read: 'read', office_render: 'read', resource_read: 'read',
  file_search: 'search', file_list: 'search', code_retrieval: 'search', retrieval_control: 'search',
  websearch: 'web', webfetch: 'web', research_search: 'web',
  file_write: 'edit', file_edit: 'edit', apply_patch: 'edit', office_write: 'edit', office_export: 'edit', file_restore: 'edit',
  wait_process: 'shell',
  memory: 'memory',
  todo: 'plan',
  dispatch: 'team', wait_child: 'team', threads: 'team', read_thread: 'team', send: 'team', submit_code: 'team', update: 'team', agent_rename: 'team',
};
const PREFIXES: readonly (readonly [string, BotToolKind])[] = [
  ['browser_', 'web'], ['process_', 'shell'], ['script_', 'shell'], ['language_', 'search'], ['child_', 'team'],
];

/** Null for tools that are not work to show: her question to you is a need, the gateway is its target. */
export function botToolKind(name: string): BotToolKind | null {
  if (name === 'ask_user' || name === 'tool_invoke') return null;
  return EXACT[name] ?? PREFIXES.find(([prefix]) => name.startsWith(prefix))?.[1] ?? 'other';
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const baseName = (value: unknown): string | null => {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value.trim().replace(/[\\/]+$/, '').split(/[\\/]/).pop() || null;
};

/**
 * What the state line names: the file a read or an edit works on, or the tool other tools are.
 * MCP tools are named by their server (`mcp__figma__get_file` → figma).
 */
export function botToolSubject(name: string, args: unknown): string | null {
  const kind = botToolKind(name), input = record(args);
  if (kind === 'read' || kind === 'edit') {
    const files = Array.isArray(input.files) ? input.files : null;
    if (files) return files.length === 1 ? baseName(record(files[0]).path) : null;
    return baseName(input.path);
  }
  if (kind !== 'other') return null;
  if (name.startsWith('mcp__')) return name.split('__')[1] || null;
  return name;
}

/** How many files one call reads or edits; one for everything else. */
export function botToolUnits(name: string, args: unknown): number {
  const kind = botToolKind(name), files = record(args).files;
  return (kind === 'read' || kind === 'edit') && Array.isArray(files) && files.length > 1 ? files.length : 1;
}
