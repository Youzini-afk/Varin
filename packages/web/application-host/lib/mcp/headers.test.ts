import { expect, test } from 'vitest';
import { mcpModelInputSchema, mcpHeaderDeclarations } from './headers.js';

test('model header projection is distinct from the unchanged executable schema and preserves value constraints', () => {
  const schema = { type: 'object', properties: { label: { type: 'string', minLength: 2, 'x-mcp-header': 'Label' },
    items: { type: 'array', minItems: 1, items: { type: 'integer', minimum: 2 } },
    value: { const: { 'x-mcp-header': 'user data' } } }, required: ['label'], additionalProperties: false };
  const original = structuredClone(schema);
  const projected = mcpModelInputSchema(schema);
  expect(mcpHeaderDeclarations(schema)).toHaveLength(1);
  expect(mcpHeaderDeclarations(projected)).toHaveLength(0);
  expect(schema).toEqual(original);
  expect(projected).toEqual({ ...original, properties: { ...original.properties, label: { type: 'string', minLength: 2 } } });
});
