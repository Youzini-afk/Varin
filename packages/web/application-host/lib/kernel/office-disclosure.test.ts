import { expect, it } from 'vitest';
import { OFFICE_TOOL_DECLARATIONS, BROWSER_TOOL_DECLARATIONS, COMPUTER_TOOL_DECLARATIONS, WEB_TOOL_DECLARATIONS } from '@varin/extension-builtins';
import { parseVarinExtensionServiceProvision } from '@varin/extension-contract';
import { extensionToolSchema } from './extension-tool-owner.js';
import { compileToolJsonSchema } from '../models/schema.js';
it('publishes original builtin contracts and valid operation addresses through the extension owner', () => {
    for (const descriptor of [...OFFICE_TOOL_DECLARATIONS, ...BROWSER_TOOL_DECLARATIONS, ...COMPUTER_TOOL_DECLARATIONS, ...WEB_TOOL_DECLARATIONS]) {
        const original = structuredClone(descriptor);
        const parsed = parseVarinExtensionServiceProvision(descriptor);
        const frozen = extensionToolSchema(parsed);
        expect(frozen.schema).toEqual(descriptor.tool!.inputSchema);
        expect(frozen.metadata?.disclosure?.summary).toBeTruthy();
        expect(descriptor).toEqual(original);
        compileToolJsonSchema(frozen.schema);
    }
    const descriptor = OFFICE_TOOL_DECLARATIONS.find(entry => entry.tool!.name === 'office_write')!;
    const validate = compileToolJsonSchema(extensionToolSchema(descriptor).schema);
    for (const content of [{ format: 'docx', blocks: [{ kind: 'paragraph', text: 'A document' }] }, { format: 'xlsx', sheets: [{ name: 'Data', rows: [[1]] }] }, { format: 'pptx', slides: [{ objects: [] }] }]) {
        expect(validate({ action: 'create', path: `file.${content.format}`, content })).toBe(true);
        expect(validate({ action: 'replace', path: `file.${content.format}`, expectedRevision: 'original', content })).toBe(true);
        expect(validate({ action: 'replace', path: `file.${content.format}`, content })).toBe(false);
    }
    expect(validate({ action: 'create', path: 'invalid.docx', content: { format: 'docx', sheets: [] } })).toBe(false);
});
