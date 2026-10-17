import { describe, it, expect } from 'vitest';
import { getToolSummary, groupToolCalls, type ToolGroupEntry } from './toolSummary.js';

describe('getToolSummary', () => {
  it('shows the disclosed target and keeps effectful calls out of read groups', () => {
    expect(getToolSummary({ toolName: 'tool_describe', arguments: { namespace: 'browser' } }))
      .toEqual({ text: 'browser', readOnly: true });
    expect(getToolSummary({ toolName: 'tool_invoke', arguments: { reference: { name: 'file_edit', version: '1' }, arguments: { path: 'src/app.ts' } } }))
      .toEqual({ text: 'file_edit · src/app.ts', readOnly: false });
    expect(getToolSummary({ toolName: 'tool_invoke', arguments: { reference: { name: 'tool_invoke' } } }))
      .toEqual({ text: 'tool_invoke', readOnly: false });
  });
  it('grep: pattern + path + hit count', () => {
    const result = getToolSummary({
      toolName: 'grep',
      arguments: { pattern: 'TODO', path: 'src/' },
      details: { hitCount: 5, fileCount: 3 },
    });
    expect(result.text).toBe('Searched TODO in src/ · 5 hits in 3 files');
    expect(result.readOnly).toBe(true);
  });

  it('read: path + range', () => {
    const result = getToolSummary({
      toolName: 'read',
      arguments: { file_path: 'src/index.ts', offset: 10, limit: 20 },
    });
    expect(result.text).toBe('Read src/index.ts:10-30');
    expect(result.readOnly).toBe(true);
  });

  it('bash: command first line + exit + duration', () => {
    const result = getToolSummary({
      toolName: 'bash',
      arguments: { command: 'npm test\n--verbose' },
      details: { exitCode: 0, durationMs: 1200 },
    });
    expect(result.text).toBe('npm test · exit 0 · 1.2s');
    expect(result.readOnly).toBe(false);
  });

  it('bash: background shell shows running', () => {
    const result = getToolSummary({
      toolName: 'bash',
      arguments: { command: 'sleep 90' },
      details: { shellId: 'sh_abc' },
    });
    expect(result.text).toContain('running · shell sh_abc');
    expect(result.readOnly).toBe(false);
  });

  it('bash: background result id is the same shell identity', () => {
    const result = getToolSummary({
      toolName: 'bash',
      arguments: { command: 'sleep 90' },
      details: { kind: 'background', id: 'sh_1' },
    });
    expect(result.text).toContain('running · shell sh_1');
  });

  it('edit: path + diff stats', () => {
    const result = getToolSummary({
      toolName: 'edit',
      arguments: { file_path: 'src/index.ts' },
      details: { added: 10, removed: 3 },
    });
    expect(result.text).toBe('Edited src/index.ts (+10 −3)');
    expect(result.readOnly).toBe(false);
  });

  it('diagnostics: path + new count', () => {
    const result = getToolSummary({
      toolName: 'diagnostics',
      arguments: { path: 'src/index.ts' },
      details: { newCount: 2 },
    });
    expect(result.text).toBe('Diagnostics src/index.ts · 2 new');
    expect(result.readOnly).toBe(true);
  });

  it('LSP navigation: path and one-based position', () => {
    expect(getToolSummary({
      toolName: 'hover',
      arguments: { path: 'src/a.ts', line: 7, character: 3 },
    })).toEqual({ text: 'Hover src/a.ts:7:3', readOnly: true });
    expect(getToolSummary({
      toolName: 'symbols',
      arguments: { path: 'src/a.ts', query: 'SessionHost' },
    })).toEqual({ text: 'Symbols SessionHost · src/a.ts', readOnly: true });
  });

  it('webfetch: url + status', () => {
    const result = getToolSummary({
      toolName: 'webfetch',
      arguments: { url: 'https://example.com/page' },
      details: { status: 'ok' },
    });
    expect(result.text).toBe('Fetched https://example.com/page · ok');
    expect(result.readOnly).toBe(true);
  });

  it('websearch: query + result count', () => {
    const result = getToolSummary({
      toolName: 'websearch',
      arguments: { query: 'hello world' },
      details: { count: 5 },
    });
    expect(result.text).toBe('Searched "hello world" · 5 results');
    expect(result.readOnly).toBe(true);
  });

  it('find: glob + count', () => {
    const result = getToolSummary({
      toolName: 'find',
      arguments: { pattern: '*.ts' },
      details: { count: 12 },
    });
    expect(result.text).toBe('Found 12 files for *.ts');
    expect(result.readOnly).toBe(true);
  });

  it('ls: path', () => {
    const result = getToolSummary({
      toolName: 'ls',
      arguments: { path: 'src/components' },
    });
    expect(result.text).toBe('Listed src/components');
    expect(result.readOnly).toBe(true);
  });

  it('unknown tool returns name only', () => {
    const result = getToolSummary({ toolName: 'custom_tool' });
    expect(result.text).toBe('custom_tool');
    expect(result.readOnly).toBe(false);
  });
});

describe('groupToolCalls', () => {
  function entry(name: string, id: string, details?: unknown, args?: unknown): ToolGroupEntry {
    return { toolName: name, toolCallId: id, details, arguments: args };
  }

  it('single read-only call stays as single', () => {
    const results = groupToolCalls([
      entry('grep', 'g1', { hitCount: 3 }, { pattern: 'test' }),
    ]);
    expect(results).toHaveLength(1);
    expect(results[0]?.type).toBe('single');
  });

  it('2+ consecutive read-only calls form a group', () => {
    const results = groupToolCalls([
      entry('grep', 'g1', { hitCount: 3 }, { pattern: 'test' }),
      entry('read', 'r1', undefined, { file_path: 'a.ts' }),
      entry('grep', 'g2', { hitCount: 1 }, { pattern: 'fix' }),
    ]);
    expect(results).toHaveLength(1);
    expect(results[0]?.type).toBe('group');
    if (results[0]?.type === 'group') {
      expect(results[0].entries).toHaveLength(3);
      expect(results[0].headerSummary).toContain('and 2 other queries');
    }
  });

  it('write tool breaks group and is not grouped', () => {
    const results = groupToolCalls([
      entry('grep', 'g1', { hitCount: 3 }, { pattern: 'test' }),
      entry('read', 'r1', undefined, { file_path: 'a.ts' }),
      entry('edit', 'e1', { added: 1, removed: 0 }, { file_path: 'a.ts' }),
      entry('grep', 'g2', { hitCount: 1 }, { pattern: 'fix' }),
    ]);
    expect(results).toHaveLength(3);
    expect(results[0]?.type).toBe('group'); // grep + read
    expect(results[1]?.type).toBe('single'); // edit
    expect(results[2]?.type).toBe('single'); // grep (alone)
  });

  it('bash is never grouped', () => {
    const results = groupToolCalls([
      entry('bash', 'b1', { exitCode: 0 }, { command: 'echo hi' }),
      entry('bash', 'b2', { exitCode: 0 }, { command: 'echo bye' }),
    ]);
    expect(results).toHaveLength(2);
    expect(results[0]?.type).toBe('single');
    expect(results[1]?.type).toBe('single');
  });

  it('does not guess that unknown extension tools are read-only', () => {
    const results = groupToolCalls([
      entry('custom_one', 'c1'),
      entry('custom_two', 'c2'),
    ]);
    expect(results).toHaveLength(2);
    expect(results.every((result) => result.type === 'single')).toBe(true);
  });

  it('empty input returns empty', () => {
    expect(groupToolCalls([])).toEqual([]);
  });

  it('group header uses first summary + count', () => {
    const results = groupToolCalls([
      entry('grep', 'g1', { hitCount: 3 }, { pattern: 'test', path: 'src/' }),
      entry('read', 'r1', undefined, { file_path: 'a.ts' }),
    ]);
    expect(results).toHaveLength(1);
    if (results[0]?.type === 'group') {
      expect(results[0].headerSummary).toBe('Searched test in src/ · 3 hits and 1 other query');
    }
  });
});
