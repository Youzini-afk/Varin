import { expect, it } from 'vitest';
import { invokedToolResult, responsesToolResult } from './provider-tool-result.test-helper.js';

function call(id: string, name: string, args: unknown = {}) {
  return { type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) };
}
function output(id: string, value: unknown) {
  return { type: 'function_call_output', call_id: id, output: [{ type: 'input_text', text: JSON.stringify(value) }] };
}
const direct = { kind: 'job_accepted', operation_id: 'dispatch-op', content: { name: 'Agent A', operationId: 'dispatch-op' } };
const wrapped = { kind: 'result', effect: 'none', content: { name: 'send', operationId: 'invoke-op',
  completion: { kind: 'job_accepted', operationId: 'send-op', effect: 'confirmed' }, result: { messageId: 'message' } } };

it('preserves a direct dispatch result containing the child name, including unnamed lookups', () => {
  const body = { input: [call('dispatch', 'dispatch'), output('dispatch', direct)] };
  expect(responsesToolResult(body, 'dispatch')).toEqual(direct);
  expect(responsesToolResult(body)).toEqual(direct);
  expect(invokedToolResult(wrapped, 'dispatch', { name: 'send' })).toBe(wrapped);
});

it('unwraps only the output matched to the actual gateway call and retains its completion', () => {
  const body = { input: [call('send', 'tool_invoke', { name: 'send', arguments: {} }),
    call('dispatch', 'dispatch'), output('dispatch', direct), output('send', wrapped)] };
  const expected = { kind: 'job_accepted', operationId: 'send-op', operation_id: 'send-op', effect: 'confirmed', content: { messageId: 'message' } };
  expect(responsesToolResult(body, 'send')).toEqual(expected);
  expect(responsesToolResult(body)).toEqual(expected);
  expect(responsesToolResult(body, 'dispatch')).toEqual(direct);
  expect(responsesToolResult(body, 'missing')).toBeUndefined();
  expect(responsesToolResult({ input: [...body.input.slice(0, 2), output('send', wrapped), output('dispatch', direct)] })).toEqual(direct);
  expect(invokedToolResult(wrapped, 'tool_invoke', { name: 'send' })).toEqual(expected);
});

it('preserves the actual inner result outcome and effect rather than the gateway observation', () => {
  const value = { ...wrapped, content: { ...wrapped.content,
    completion: { kind: 'result', outcome: 'succeeded', effect: 'confirmed' }, result: { revision: 1 } } };
  expect(invokedToolResult(value, 'tool_invoke', { name: 'send' })).toEqual({
    kind: 'result', outcome: 'succeeded', effect: 'confirmed', operation_id: undefined, content: { revision: 1 },
  });
});

it('keeps gateway failures and incomplete or mismatched envelopes intact', () => {
  for (const value of [
    { kind: 'not_dispatched', reason: 'denied', content: { name: 'send', error: 'denied' } },
    { ...wrapped, content: { ...wrapped.content, completion: null } },
    { ...wrapped, content: { ...wrapped.content, completion: { kind: 'job_accepted' } } },
    { ...wrapped, content: { name: 'send', operationId: 'invoke-op', completion: wrapped.content.completion } },
    { ...wrapped, content: { ...wrapped.content, name: 'another-tool' } },
  ]) {
    expect(invokedToolResult(value, 'tool_invoke', { name: 'send' })).toBe(value);
    expect(responsesToolResult({ input: [call('send', 'tool_invoke', { name: 'send' }), output('send', value)] })).toEqual(value);
  }
});

it('retains a gateway rejection whose original target result is null', () => {
  const value = { ...wrapped, content: { ...wrapped.content, completion: { kind: 'not_dispatched', reason: 'stale revision' }, result: null } };
  expect(invokedToolResult(value, 'tool_invoke', { name: 'send' })).toEqual({ kind: 'not_dispatched', reason: 'stale revision', operation_id: undefined, content: null });
});
