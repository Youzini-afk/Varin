import { describe, expect, test } from 'vitest';
import { updateJsoncPath } from './plugin-config-model';
import { aftBashDraftMode, aftDraftIssues } from './aft-config-model';

describe('AFT config model', () => {
  test('preserves unknown top-level fields and reports them without blocking save', () => {
    const draft = { enabled: true, future_transport: { mode: 'later' } };
    const before = structuredClone(draft);
    const issues = aftDraftIssues(draft, 'global');

    expect(draft).toEqual(before);
    expect(issues.some((candidate) => JSON.stringify(candidate) === JSON.stringify({
      blocking: false,
      code: 'unknown-field',
      field: 'future_transport',
    }))).toBe(true);
    expect(issues.some((issue) => issue.blocking)).toBe(false);
  });

  test('blocks invalid known fields, including Advanced-only schema sections', () => {
    const issues = aftDraftIssues({
      enabled: 'yes',
      formatter_timeout_secs: 0,
      formatter: { '.ts': 'unknown' },
      gh_shim: { enabled: 'yes' },
      inspect: { diagnostics_timeout_ms: 9_999 },
      lsp: { grace_days: 0 },
      semantic: { timeout_ms: -1 },
    }, 'global');

    const has = (code: string, field: string) => issues.some((candidate) => (
      candidate.blocking && candidate.code === code && candidate.field === field
    ));
    expect(has('invalid-boolean', 'enabled')).toBe(true);
    expect(has('invalid-number', 'formatter_timeout_secs')).toBe(true);
    expect(has('invalid-value', 'formatter..ts')).toBe(true);
    expect(has('invalid-number', 'lsp.grace_days')).toBe(true);
    expect(has('invalid-number', 'semantic.timeout_ms')).toBe(true);
    expect(has('invalid-boolean', 'gh_shim.enabled')).toBe(true);
    expect(has('invalid-number', 'inspect.diagnostics_timeout_ms')).toBe(true);
  });

  test('diagnoses the complete project strip surface without blocking', () => {
    const issues = aftDraftIssues({
      restrict_to_project_root: true,
      url_fetch_allow_private: true,
      bridge: { request_timeout_ms: 1000 },
      backup: { enabled: true },
      subc: { client_reaper: true },
      formatter_timeout_secs: 30,
      gh_shim: { enabled: false },
      disabled_tools: ['other', 'aft_safety'],
      semantic: {
        backend: 'fastembed',
        base_url: 'https://example.test',
        api_key_env: 'AFT_KEY',
        query_timeout_ms: 1000,
        model: 'model',
        timeout_ms: 1000,
        max_batch_size: 10,
        max_files: 100,
      },
      lsp: {
        servers: {},
        disabled: [],
        auto_install: true,
        grace_days: 7,
        versions: {},
        python: 'auto',
        diagnostics_on_edit: true,
      },
      sandbox: {
        enabled: false,
        write_allow: ['C:/temp'],
        read_deny: ['C:/secret'],
      },
    }, 'project');
    const ignored = issues
      .filter((issue) => issue.code === 'ignored-project')
      .map((issue) => issue.field)
      .sort();

    expect(ignored).toEqual([
      'backup',
      'bridge',
      'disabled_tools.aft_safety',
      'formatter_timeout_secs',
      'gh_shim',
      'lsp.auto_install',
      'lsp.disabled',
      'lsp.grace_days',
      'lsp.servers',
      'lsp.versions',
      'restrict_to_project_root',
      'sandbox.enabled',
      'sandbox.write_allow',
      'semantic.api_key_env',
      'semantic.backend',
      'semantic.base_url',
      'semantic.query_timeout_ms',
      'subc',
      'url_fetch_allow_private',
    ]);
    expect(issues.some((issue) => issue.blocking)).toBe(false);
  });

  test('keeps a custom bash object byte-for-byte while another JSONC field changes', () => {
    const source = `{
  // custom bash tuning
  "bash": {
    "rewrite": false,
    "host_fallback": true,
  },
  "enabled": true,
}\n`;
    const custom = {
      bash: { rewrite: false, host_fallback: true },
      enabled: true,
    };

    expect(aftBashDraftMode(custom)).toBe('custom');
    const next = updateJsoncPath(source, ['enabled'], false);
    expect(next).toContain('// custom bash tuning');
    expect(next).toContain('"rewrite": false');
    expect(next).toContain('"host_fallback": true');
  });
});
