import { expect, it } from 'vitest';
import { projectMcpOutput } from './mcp-output.js';

it('projects only explicit MCP payload positions and preserves ordering, metadata, roles and unknown fields', () => {
  const result = {
    content: [
      { type: 'text', text: 'before', outputPartIndex: 'remote metadata', _meta: { n: 1 } },
      { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png', annotations: { audience: ['assistant'] } },
      { type: 'resource', resource: { uri: 'fixture:///body', text: 'embedded', blob: 'YmxvYg==', _meta: { original: true } } },
      { type: 'resource_link', uri: 'https://never-fetch.invalid/image', name: 'link' },
      { type: 'future', nested: { type: 'image', data: 'not media' } },
      { type: 'audio', data: 'YXVkaW8=', mimeType: 'audio/wav' },
    ],
    structuredContent: { type: 'image', data: 'ordinary structured data' },
    _meta: { data: 'ordinary metadata' },
    isError: true,
  };
  const original = structuredClone(result);
  const output = projectMcpOutput(result, 'tool');
  expect(result).toEqual(original);
  expect(output.parts).toEqual([
    { kind: 'text', text: 'before' },
    { kind: 'media', media: { media_type: 'image/png', data_base64: 'aW1hZ2U=' } },
    { kind: 'text', text: 'embedded' },
    { kind: 'media', media: { media_type: 'application/octet-stream', data_base64: 'YmxvYg==' } },
    { kind: 'media', media: { media_type: 'audio/wav', data_base64: 'YXVkaW8=' } },
  ]);
  const data = output.data as typeof result;
  expect(data.content[0]).toEqual({ ...result.content[0], text: { outputPartIndex: 0 } });
  expect(data.content[1]).toEqual({ ...result.content[1], data: { outputPartIndex: 1 } });
  expect(data.content[2]).toEqual({ ...result.content[2], resource: { ...result.content[2]!.resource, text: { outputPartIndex: 2 }, blob: { outputPartIndex: 3 } } });
  expect(data.content.slice(3, 5)).toEqual(result.content.slice(3, 5));
  expect(data.structuredContent).toEqual(result.structuredContent);
  expect(data._meta).toEqual(result._meta);
  expect(data.isError).toBe(true);
  expect(projectMcpOutput({ messages: [{ role: 'user', content: result.content[1], _meta: { role: 'not authority' } }] }, 'prompt')).toEqual({
    data: { messages: [{ role: 'user', content: { ...result.content[1], data: { outputPartIndex: 0 } }, _meta: { role: 'not authority' } }] },
    parts: [output.parts[1]],
  });
});

it('keeps malformed byte encodings in typed admission rather than JSON and does not change response outcomes', () => {
  const result = { contents: [{ uri: 'fixture:///bad', blob: '!!invalid!!', mimeType: 'image/png' }], isError: false };
  expect(projectMcpOutput(result, 'resource')).toEqual({
    data: { contents: [{ ...result.contents[0], blob: { outputPartIndex: 0 } }], isError: false },
    parts: [{ kind: 'media', media: { media_type: 'image/png', data_base64: '!!invalid!!' } }],
  });
});

it('keeps received results intact when a known media MIME is missing or malformed', () => {
  const prompt = projectMcpOutput({ messages: [{ role: 'assistant', content: { type: 'image', data: 'Ynl0ZXM=' } }] }, 'prompt');
  expect(prompt.parts).toEqual([{ kind: 'media', media: { media_type: '', data_base64: 'Ynl0ZXM=' } }]);
  const resource = projectMcpOutput({ contents: [{ uri: 'fixture:///bad-mime', blob: 'Ynl0ZXM=', mimeType: 42 }] }, 'resource');
  expect(resource.parts).toEqual([{ kind: 'media', media: { media_type: '', data_base64: 'Ynl0ZXM=' } }]);
  expect(resource.data).toEqual({ contents: [{ uri: 'fixture:///bad-mime', blob: { outputPartIndex: 0 }, mimeType: 42 }] });
});
