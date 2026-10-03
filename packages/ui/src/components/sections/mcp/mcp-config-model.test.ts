import { describe, expect, test } from 'vitest';
import { readJsonPath } from '@/components/sections/plugin-settings/plugin-config-model';
import {
  canLeaveMcpConfigSource,
  mcpSourceBoundSnapshot,
  mcpServerNames,
  mcpServerSourceConflicts,
  mcpServerTransport,
  mcpSourceBooleanState,
  parseMcpConfigObject,
  prepareMcpConfigForSave,
  setMcpConfigValue,
  switchMcpServerTransport,
  updateMcpServerUrl,
} from './mcp-config-model';

describe('MCP native config editing', () => {
  test('discovers current server names and transport without computing merged state', () => {
    const document = parseMcpConfigObject(`{
      "mcpServers": {
        "remote": { "url": "https://example.com/mcp" },
        "local": { "command": "node" }
      }
    }`);
    expect(mcpServerNames(document)).toEqual(['local', 'remote']);
    expect(mcpServerTransport(document, 'local')).toBe('stdio');
    expect(mcpServerTransport(document, 'remote')).toBe('http');
    expect(mcpServerTransport(document, 'future')).toBe('unconfigured');
  });

  test('keeps absent sampling and elicitation as source-local not-set states', () => {
    const absent = parseMcpConfigObject('{ "settings": { "samplingAutoApprove": false } }');
    expect(mcpSourceBooleanState(absent, ['settings', 'sampling'])).toBe('not-set');
    expect(mcpSourceBooleanState(absent, ['settings', 'elicitation'])).toBe('not-set');
    expect(mcpSourceBooleanState(absent, ['settings', 'samplingAutoApprove'])).toBe('disabled');

    const explicit = parseMcpConfigObject(`{
      "settings": { "sampling": true, "elicitation": false }
    }`);
    expect(mcpSourceBooleanState(explicit, ['settings', 'sampling'])).toBe('enabled');
    expect(mcpSourceBooleanState(explicit, ['settings', 'elicitation'])).toBe('disabled');
  });

  test('blocks leaving a source until its dirty draft is saved or discarded', () => {
    expect(canLeaveMcpConfigSource(false)).toBe(true);
    expect(canLeaveMcpConfigSource(true)).toBe(false);
  });

  test('never reuses a revision from another native source after its load fails', () => {
    const sourceASnapshot = { path: '.pi/mcp.json', revision: 'source-a' };
    expect(mcpSourceBoundSnapshot(sourceASnapshot, 'project:pi', 'project:pi')).toBe(sourceASnapshot);
    expect(mcpSourceBoundSnapshot(sourceASnapshot, 'project:pi', 'project:shared')).toBeNull();
  });

  test('reports duplicate server definitions by source without computing merged values', () => {
    expect(mcpServerSourceConflicts({
      global: ['docs', 'github'],
      project: ['docs'],
      user: ['github', 'linear'],
    }, ['global', 'user', 'project'])).toEqual([
      ['docs', ['global', 'project']],
      ['github', ['global', 'user']],
    ]);
  });

  test('switches transport in the selected source while preserving unrelated fields and comments', () => {
    const source = `{
      // Pi project override
      "mcpServers": {
        "docs": {
          "url": "https://example.com/mcp",
          "headers": { "Authorization": "$DOCS_TOKEN" },
          "disabled": true,
          "future": { "preserve": true }
        }
      },
      "settings": { "toolPrefix": "short" }
    }`;
    const next = switchMcpServerTransport(source, 'docs', 'stdio');
    const document = parseMcpConfigObject(next);
    expect(next).toContain('// Pi project override');
    expect(readJsonPath(document, ['mcpServers', 'docs'])).toEqual({
      command: '',
      disabled: true,
      future: { preserve: true },
    });
    expect(readJsonPath(document, ['settings'])).toEqual({ toolPrefix: 'short' });
    expect(next).not.toContain('Authorization');
    expect(next).not.toContain('"url"');
  });

  test('clears URL-bound local credentials only when the saved URL changed', () => {
    const source = JSON.stringify({
      mcpServers: {
        docs: {
          auth: 'oauth',
          bearerToken: '$OLD_TOKEN',
          headers: { 'X-Api-Key': '$OLD_KEY' },
          oauth: { clientId: 'old-client', clientSecret: '$OLD_SECRET' },
          trace: true,
          url: 'https://old.example/mcp',
        },
        localPolicy: {
          oauth: false,
          url: 'https://old.example/mcp',
        },
      },
    }, null, 2);

    const edited = updateMcpServerUrl(source, 'docs', 'https://new.example/mcp');
    expect(readJsonPath(parseMcpConfigObject(edited), ['mcpServers', 'docs', 'bearerToken']))
      .toBe('$OLD_TOKEN');
    const changed = parseMcpConfigObject(prepareMcpConfigForSave(source, edited));
    expect(readJsonPath(changed, ['mcpServers', 'docs'])).toEqual({
      auth: 'oauth',
      trace: true,
      url: 'https://new.example/mcp',
    });

    const keptFalse = parseMcpConfigObject(prepareMcpConfigForSave(
      source,
      updateMcpServerUrl(source, 'localPolicy', 'https://new.example/mcp'),
    ));
    expect(readJsonPath(keptFalse, ['mcpServers', 'localPolicy'])).toEqual({
      oauth: false,
      url: 'https://new.example/mcp',
    });

    const restored = updateMcpServerUrl(
      updateMcpServerUrl(source, 'docs', 'https://temporary.example/mcp'),
      'docs',
      'https://old.example/mcp',
    );
    expect(prepareMcpConfigForSave(source, restored)).toBe(restored);
    expect(readJsonPath(parseMcpConfigObject(restored), ['mcpServers', 'docs', 'headers']))
      .toEqual({ 'X-Api-Key': '$OLD_KEY' });
  });

  test('preserves JSONC comments and unknown fields through source-local structured edits', () => {
    const source = `{
      // Preserve future adapter configuration
      "futureRoot": { "enabled": true },
      "settings": {
        "futureSetting": "keep"
      },
      "mcpServers": {
        "docs": {
          "url": "https://old.example/mcp",
          "headers": { "X-Api-Key": "$OLD_KEY" },
          "bearerTokenEnv": "OLD_TOKEN",
          "futureServerField": { "keep": true }
        }
      }
    }`;

    const withSampling = setMcpConfigValue(source, ['settings', 'sampling'], true);
    const repointed = prepareMcpConfigForSave(
      source,
      updateMcpServerUrl(withSampling, 'docs', 'https://new.example/mcp'),
    );
    const document = parseMcpConfigObject(repointed);

    expect(repointed).toContain('// Preserve future adapter configuration');
    expect(readJsonPath(document, ['futureRoot'])).toEqual({ enabled: true });
    expect(readJsonPath(document, ['settings'])).toEqual({
      futureSetting: 'keep',
      sampling: true,
    });
    expect(readJsonPath(document, ['mcpServers', 'docs'])).toEqual({
      futureServerField: { keep: true },
      url: 'https://new.example/mcp',
    });
  });
});
