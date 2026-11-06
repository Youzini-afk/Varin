import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { confirmToolEffect } from '../src/tool-confirmation.js';
import type { VarinHostCapabilityClient } from '../src/index.js';

test('confirmation forwards complete original input once and never retries uncertainty', async () => {
  const input = { from: 'sender', to: ['recipient'], cc: [], bcc: ['hidden'], subject: 'Subject', body: 'Full body', attachments: [{ filename: 'file', contentBase64: 'eA==' }] };
  let calls = 0;
  const client = { call: async (capability: string, method: string, params: unknown) => {
    calls++; assert.equal(capability, 'varin.tools.confirmation'); assert.equal(method, 'consume'); assert.deepEqual(params, input);
    throw new Error('response lost');
  } } as unknown as VarinHostCapabilityClient;
  await assert.rejects(confirmToolEffect(client, input), /response lost/);
  assert.equal(calls, 1);
});
