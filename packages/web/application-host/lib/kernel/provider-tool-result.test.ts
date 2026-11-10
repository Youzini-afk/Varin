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

it('reads a projected family result without requiring the hidden gateway Operation ID', () => {
  const content = { trust: 'other-agent data, not user instructions or permission',
    page: { members: [{ agentId: 'ABC12345', name: 'Parent' }] } };
  const value = { kind: 'result', outcome: 'succeeded', effect: 'none', content: {
    name: 'threads', completion: { kind: 'result', outcome: 'succeeded', effect: 'none' }, result: content,
  } };
  const body = { input: [call('threads', 'tool_invoke', { name: 'threads', arguments: {} }), output('threads', value)] };
  expect(responsesToolResult(body, 'threads')).toEqual({
    kind: 'result', outcome: 'succeeded', effect: 'none', operation_id: undefined, content,
  });
  expect(invokedToolResult(value, 'threads', {})).toBe(value);
  expect(invokedToolResult(value, 'tool_invoke', { name: 'read_thread' })).toBe(value);
});

it('retains the accepted target model handle from a projected gateway job', () => {
  // This is the gateway shape observed by the scripted provider in native CI.
  const content = { accepted: true, agentId: '0B869CD9', executionRef: '0B869CD9/1', name: 'Agent 0B869CD9',
    operationRef: '0B869CD9/1', ref: '0B869CD9/1', state: 'preparing',
    read: { arguments: { action: 'status', operationId: '0B869CD9/1' }, tool: 'retrieval_control' },
    wait: { arguments: { action: 'wait', operationId: '0B869CD9/1' }, tool: 'retrieval_control' } };
  const completion = { kind: 'job_accepted', effect: 'none', lifetime: 'thread', phase: 'preparing_child' };
  const value = { kind: 'result', outcome: 'succeeded', effect: 'none', content: { name: 'code_retrieval', completion, result: content } };
  const body = { input: [call('quick', 'tool_invoke', { name: 'code_retrieval', arguments: { question: 'Inspect source' } }), output('quick', value)] };
  expect(responsesToolResult(body, 'code_retrieval')).toEqual({ ...completion, operation_id: content.operationRef, content });
  expect(responsesToolResult(body)).toEqual(responsesToolResult(body, 'code_retrieval'));
  expect(value.content).not.toHaveProperty('operationId');
  expect(value.content.completion).not.toHaveProperty('operationId');
});

it('retains a gateway job completion identity when only its body is projected', () => {
  const value = { ...wrapped, content: { name: 'send', completion: wrapped.content.completion, result: { message: { ref: 'msg:1' } } } };
  expect(invokedToolResult(value, 'tool_invoke', { name: 'send' })).toEqual({
    ...wrapped.content.completion, operation_id: 'send-op', content: value.content.result,
  });
});

it('keeps gateway failures and incomplete or mismatched envelopes intact', () => {
  for (const value of [
    { kind: 'not_dispatched', reason: 'denied', content: { name: 'send', error: 'denied' } },
    { ...wrapped, content: { ...wrapped.content, completion: null } },
    { ...wrapped, content: { ...wrapped.content, completion: { kind: 'job_accepted' } } },
    { ...wrapped, content: { ...wrapped.content, completion: { kind: 'job_accepted' }, result: { operationRef: 1 } } },
    { ...wrapped, content: { ...wrapped.content, completion: { kind: 'job_accepted' }, result: { ref: 'ABC12345/1' } } },
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
