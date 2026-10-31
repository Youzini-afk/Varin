import { describe, expect, it } from 'vitest';
import { botToolKind, botToolSubject, botToolUnits } from './botStageTools';

describe('Bot tool props', () => {
  it('classifies exact tool names, never their arguments', () => {
    expect(['file_read', 'file_search', 'websearch', 'browser_open', 'file_edit', 'process_spawn', 'script_run', 'memory', 'todo', 'dispatch', 'child_status', 'mcp__figma__get_file']
      .map(botToolKind)).toEqual(['read', 'search', 'web', 'web', 'edit', 'shell', 'shell', 'memory', 'plan', 'team', 'team', 'other']);
    expect(botToolKind('ask_user')).toBeNull();
    expect(botToolKind('tool_invoke')).toBeNull();
    expect(botToolKind('file_read_everything')).toBe('other');
  });

  it('names the file or the tool, and counts files of one call', () => {
    expect(botToolSubject('file_edit', { path: 'docs/design/notes.md' })).toBe('notes.md');
    expect(botToolSubject('file_read', { files: [{ path: 'a.ts' }, { path: 'b.ts' }] })).toBeNull();
    expect(botToolUnits('file_read', { files: [{ path: 'a.ts' }, { path: 'b.ts' }] })).toBe(2);
    expect(botToolSubject('mcp__figma__get_file', {})).toBe('figma');
    expect(botToolSubject('process_spawn', { shellCommand: 'rm -rf /' })).toBeNull();
  });
});
