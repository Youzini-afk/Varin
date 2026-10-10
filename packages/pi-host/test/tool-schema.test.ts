import assert from 'node:assert/strict';
import { it } from 'node:test';
import { compileToolJsonSchema } from '../src/tool-schema.js';

it('shared Host schema validation preserves input/output values and rejects unsupported validation work', () => {
  for (const $schema of ['http://json-schema.org/draft-07/schema#', 'https://json-schema.org/draft/2019-09/schema', 'https://json-schema.org/draft/2020-12/schema']) {
    const schema = { $schema, type: 'object', properties: { count: { type: 'integer', default: 3 }, url: { type: 'string', format: 'uri' } }, required: ['count'], additionalProperties: false };
    const validate = compileToolJsonSchema(schema);
    const input = { count: '2', extra: true };
    assert.equal(validate(input), false);
    assert.deepEqual(input, { count: '2', extra: true }, 'validation must not coerce or remove fields');
    const missing = {};
    assert.equal(validate(missing), false);
    assert.deepEqual(missing, {}, 'validation must not materialize defaults');
    assert.equal(validate({ count: 2, url: 'https://example.invalid/material' }), true);
    assert.equal(validate({ count: 2, url: 'not a URI' }), false);
  }
  const output = compileToolJsonSchema({ anyOf: [{ type: 'null' }, { type: 'array', items: { type: 'string' } }] });
  assert.equal(output(null), true);
  assert.equal(output([]), true);
  assert.equal(output(['界']), true);
  assert.equal(output({}), false);
  assert.equal(compileToolJsonSchema(false)(null), false);
  assert.throws(() => compileToolJsonSchema({ $async: true, type: 'string' }), /async/);
  assert.throws(() => compileToolJsonSchema({ $ref: 'https://example.invalid/unfetched-schema' }));
});
