import { describe, expect, test } from 'vitest';
import { mcpServerCommandArgument, parseMcpAdapterStatus } from './mcpAdapterStatus';

describe('MCP adapter status contract', () => {
  test('accepts the public version-one snapshot and preserves optional counts', () => {
    expect(parseMcpAdapterStatus({
      connectedCount: 1,
      disabledCount: 0,
      servers: [{
        disabled: false,
        name: 'docs',
        resourceCount: 3,
        status: 'connected',
        toolCount: 2,
      }],
      totalResources: 3,
      totalTools: 2,
      version: 1,
    })).toEqual({
      connectedCount: 1,
      disabledCount: 0,
      servers: [{
        disabled: false,
        name: 'docs',
        resourceCount: 3,
        status: 'connected',
        toolCount: 2,
      }],
      totalResources: 3,
      totalTools: 2,
      version: 1,
    });
  });

  test('does not guess at unknown versions or malformed server entries', () => {
    expect(parseMcpAdapterStatus({ version: 2, servers: [] })).toBeNull();
    expect(parseMcpAdapterStatus({
      connectedCount: 0,
      disabledCount: 0,
      servers: [{ disabled: false, name: 'docs', status: 'future', toolCount: 0 }],
      totalResources: 0,
      totalTools: 0,
      version: 1,
    })).toBeNull();
  });

  test('only emits server names representable by the adapter command parser', () => {
    expect(mcpServerCommandArgument('docs')).toBe('docs');
    expect(mcpServerCommandArgument('  docs  ')).toBe('docs');
    expect(mcpServerCommandArgument('team docs')).toBeNull();
    expect(mcpServerCommandArgument('team\ndocs')).toBeNull();
    expect(mcpServerCommandArgument('')).toBeNull();
  });
});
