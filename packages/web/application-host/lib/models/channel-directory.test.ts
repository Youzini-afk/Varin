import { expect, test } from 'vitest';
import { directoryChannel, parseChannelDirectory } from './channel-directory.js';
import type { ChannelType } from './channel-types.js';

// The shape prepareDirectory() hands directoryChannel() for an openai-completions entry.
const template = {
  id: 'openai-compatible', name: 'OpenAI compatible', protocol: 'openai-completions',
  authentication: ['credential', 'environment', 'none'],
  operations: ['chat', 'embedding', 'rerank', 'decision', 'image-generation', 'image-editing'],
  discovery: true,
  parametersSchema: { type: 'object', properties: { decisionApi: { enum: ['typesafe-system-one'] } }, additionalProperties: false },
  defaultParameters: { decisionApi: 'typesafe-system-one' },
} as unknown as ChannelType;

const local = (extra: Record<string, unknown> = {}) => ({
  version: 1,
  channels: [{ id: 'relay', name: 'Relay', kind: 'local', protocol: 'openai-completions', baseUrl: 'http://127.0.0.1:9999/v1', ...extra }],
});

test('an entry that does not opt in keeps the chat-only shape', () => {
  const [entry] = parseChannelDirectory(local());
  const type = directoryChannel(entry!, template);
  expect(type.operations).toEqual(['chat']);
  expect(type.parametersSchema).toEqual({ type: 'object', properties: {}, additionalProperties: false });
  expect(type.defaultParameters).toBeUndefined();
});

test('inheritCapabilities takes the protocol template\'s operations and parameters', () => {
  const [entry] = parseChannelDirectory(local({ inheritCapabilities: true }));
  expect(entry!.inheritCapabilities).toBe(true);
  const type = directoryChannel(entry!, template);
  expect(type.operations).toEqual(template.operations);
  expect(type.parametersSchema).toEqual(template.parametersSchema);
  expect(type.defaultParameters).toEqual({ decisionApi: 'typesafe-system-one' });
});

test('inheriting leaves the entry\'s own endpoint and local authentication alone', () => {
  const [entry] = parseChannelDirectory(local({ inheritCapabilities: true }));
  const type = directoryChannel(entry!, template);
  expect(type.defaultBaseUrl).toBe('http://127.0.0.1:9999/v1');
  expect(type.authentication).toEqual(['none', 'credential', 'environment']);
  expect(type.discovery).toBe(true);
});

test('a template that is not installed still yields a usable chat-only type', () => {
  const [entry] = parseChannelDirectory(local({ inheritCapabilities: true }));
  const type = directoryChannel(entry!, undefined);
  expect(type.operations).toEqual(['chat']);
  expect(type.parametersSchema).toEqual({ type: 'object', properties: {}, additionalProperties: false });
});

test('inheritCapabilities must be a boolean when present', () => {
  expect(() => parseChannelDirectory(local({ inheritCapabilities: 'yes' }))).toThrow('Invalid channel directory entry');
  expect(() => parseChannelDirectory(local({ inheritCapabilities: 1 }))).toThrow('Invalid channel directory entry');
});

test('anything but true is dropped, so a stray value cannot enable it', () => {
  const [entry] = parseChannelDirectory(local({ inheritCapabilities: false }));
  expect(entry!.inheritCapabilities).toBeUndefined();
  const type = directoryChannel(entry!, template);
  expect(type.operations).toEqual(['chat']);
});
