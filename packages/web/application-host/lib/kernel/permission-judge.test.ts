import { expect, it, vi } from 'vitest';
import { createPermissionJudge } from './permission-judge.js';

it('judges one call from its declared argument shape and asks when the model cannot decide', async () => {
  const model = { providerId: 'judge-provider', modelId: 'judge-model' };
  const generate = vi.fn(async () => ({ text: '{"decision":"allow"}' }));
  const judge = createPermissionJudge({ selectModel: async () => model, generate });
  const signal = new AbortController().signal;
  const call = { operationId: 'op', name: 'fixture_lookup', description: 'Look up an entry', operation: 'mcp' as const,
    schema: { properties: { identifier: { type: 'string' }, options: { type: 'object' } } },
    arguments: { identifier: 'private identifier', options: { 'private key': 'private value' } },
  };

  await expect(judge(call, signal)).resolves.toBe(true);
  expect(generate).toHaveBeenCalledWith(expect.objectContaining({ key: 'permission-judge:op', model, signal,
    prompt: JSON.stringify({ tool: call.name, description: call.description, operation: 'mcp',
      arguments: { identifier: 'string', options: 'object' } }),
  }));
  generate.mockResolvedValueOnce({ text: '{"decision":"ask"}' });
  await expect(judge(call, signal)).resolves.toBe(false);
  generate.mockResolvedValueOnce({ text: 'allow' });
  await expect(judge(call, signal)).resolves.toBe(false);
  generate.mockRejectedValueOnce(new Error('provider unavailable'));
  await expect(judge(call, signal)).resolves.toBe(false);
  await expect(createPermissionJudge({ selectModel: async () => null, generate })(call, signal)).resolves.toBe(false);
  expect(generate).toHaveBeenCalledTimes(4);
});
