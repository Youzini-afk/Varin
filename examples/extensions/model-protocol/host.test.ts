import { expect, test } from 'vitest';
import { protocol } from './host.js';
import type { ModelProtocolCall } from '@varin/extension-contract';
const input = (frame: unknown, state: unknown = null): Extract<ModelProtocolCall, { kind: 'parse' }> => ({ kind: 'parse',
  request_id: 'original-request', run_id: 'original-run', connection_identity: 'original-account', frame: frame === null ? null : JSON.stringify(frame), state });
test('the example codec preserves complete text, original continuation scope and provider usage without inventing missing counts', () => {
  const delta = protocol(input({ kind: 'delta', text: 'Hello' })); expect(delta).toMatchObject({ state: 'Hello', finish: null });
  const completed = protocol(input({ kind: 'complete', text: 'Hello', continuation: 'receipt', outputTokens: 0 }, 'Hello'));
  expect(completed).toMatchObject({ finish: 'stop', events: [
    { kind: 'item_completed', item: { content: { text: 'Hello' }, opaque: { connection_identity: 'original-account', family: 'example-text-sse', value: { continuation: 'receipt' } } } },
    { kind: 'usage', receipt: { input_tokens: null, output_tokens: 0, measurement: 'actual' } },
  ] });
  expect(protocol(input(null, 'partial'))).toMatchObject({ finish: null, state: 'partial' });
  expect(() => protocol(input({ kind: 'complete', text: 'wrong', continuation: 'receipt' }, 'partial'))).toThrow('completion');
  expect(() => protocol(input({ kind: 'complete', text: '', continuation: 'receipt', outputTokens: -1 }, ''))).toThrow('usage');
});
