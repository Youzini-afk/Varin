import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parseVarinExtensionToolDeclaration } from '../src/tools.js';

test('one-action confirmation is explicit and never accepts weaker modes', () => {
  const tool = { name: 'send', description: 'Send original content', completion: 'result', operation: 'effect', inputSchema: true, outputSchema: true };
  assert.equal(parseVarinExtensionToolDeclaration(tool).confirmation, undefined);
  assert.equal(parseVarinExtensionToolDeclaration({ ...tool, confirmation: 'always' }).confirmation, 'always');
  for (const confirmation of ['auto', 'never', false, null]) assert.throws(() => parseVarinExtensionToolDeclaration({ ...tool, confirmation }), /confirmation/);
});
