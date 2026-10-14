import { expect, test } from 'vitest';
import { readJsonPath } from '@/lib/jsonConfig';
import { mcpSourceBooleanState, mcpServerTransport, parseMcpConfigObject, setMcpConfigValue, switchMcpServerTransport } from './mcp-config-model';
test('projects actual native HTTP and stdio source configuration', () => {
  const document = parseMcpConfigObject('{"mcpServers":{"web":{"url":"https://example.test/mcp"},"local":{"command":"node"}}}');
  expect(mcpServerTransport(document, 'web')).toBe('http'); expect(mcpServerTransport(document, 'local')).toBe('stdio');
  expect(mcpServerTransport(document, 'missing')).toBe('unconfigured');
});
test('keeps absent, disabled and enabled source choices distinct', () => {
  const document = parseMcpConfigObject('{"autoEnableCodemode":false,"mcpServers":{"local":{"enabled":true}}}');
  expect(mcpSourceBooleanState(document, ['autoEnableCodemode'])).toBe('disabled');
  expect(mcpSourceBooleanState(document, ['mcpServers', 'local', 'enabled'])).toBe('enabled');
  expect(mcpSourceBooleanState(document, ['missing'])).toBe('not-set');
});
test('switches transport without retaining credentials for an incompatible endpoint type', () => {
  const source = '{\n// keep source comment\n"mcpServers":{"docs":{"url":"https://example.test","headers":{"Authorization":"secret"},"auth":{"provider":"saved"},"enabled":false}}}';
  const edited = switchMcpServerTransport(source, 'docs', 'stdio');
  expect(edited).toContain('// keep source comment');
  expect(readJsonPath(parseMcpConfigObject(edited), ['mcpServers','docs'])).toEqual({ command: '', type: 'stdio', enabled: false });
});
test('edits a selected JSONC field without mutating unrelated configuration', () => {
  const source = '{\n// source comment\n"mcpServers":{"docs":{"command":"node"}},"autoEnableCodemode":false}';
  const edited = setMcpConfigValue(source, ['mcpServers','docs','args'], ['server.js']);
  expect(edited).toContain('// source comment');
  expect(parseMcpConfigObject(edited)).toEqual({mcpServers:{docs:{command:'node',args:['server.js']}},autoEnableCodemode:false});
});
