import { expect, it } from 'vitest';
import { OFFICE_TOOL_DECLARATIONS } from '../../../../extension-builtins/src/office-tools.js';
import { compileToolJsonSchema, describeToolSchemaFailure } from './schema.js';

const office = (name: string) => compileToolJsonSchema(OFFICE_TOOL_DECLARATIONS.find(d => d.tool?.name === name)!.tool!.inputSchema);

it('explains export input alternatives and missing destination together, without disclosing argument values', () => {
  const validate = office('office_export');
  const input = { format: 'pdf', unexpected: 'PRIVATE_CONTENT' };
  expect(validate(input)).toBe(false);
  const error = describeToolSchemaFailure(validate, input);
  expect(error).toContain('/path: required (Output destination');
  expect(error).toContain('exactly one');
  expect(error).toContain('sourcePath OR requires snapshotId');
  expect(error).toContain('/unexpected: unknown field');
  expect(error).not.toContain('PRIVATE_CONTENT');
  const valid = { format: 'pdf', sourcePath: 'source.docx', path: 'result.pdf' };
  expect(validate(valid)).toBe(true);
  expect(validate({ ...valid, snapshotId: 'also-selected' })).toBe(false);
  expect(describeToolSchemaFailure(validate, { ...valid, snapshotId: 'also-selected' })).toContain('exactly one');
});

it('reports only the selected Office format and nested action, independently for each array element', () => {
  const validate = office('office_write');
  const input = { action: 'create', path: 'a.docx', content: { format: 'docx', blocks: [
    { kind: 'table' }, { kind: 'paragraph', text: 123 },
  ] } };
  expect(validate(input)).toBe(false);
  const error = describeToolSchemaFailure(validate, input);
  expect(error).toContain('/content/blocks/0/rows: required');
  expect(error).toContain('/content/blocks/1/text: must be string');
  expect(error).not.toMatch(/sheets|slides|expectedRevision|edits/);
});
