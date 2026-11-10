import { expect, it } from 'vitest';
import { OFFICE_TOOL_DECLARATIONS, BROWSER_TOOL_DECLARATIONS, COMPUTER_TOOL_DECLARATIONS, WEB_TOOL_DECLARATIONS, INTERACTIVE_UI_TOOL_DECLARATIONS } from '@varin/extension-builtins';
import { normalizeConversationUi } from '@varin/application-client';
import { parseVarinExtensionServiceProvision } from '@varin/extension-contract';
import { extensionToolSchema } from './extension-tool-owner.js';
import { compileToolJsonSchema } from '../models/schema.js';
it('publishes original builtin contracts and valid operation addresses through the extension owner', () => {
    for (const descriptor of [...OFFICE_TOOL_DECLARATIONS, ...BROWSER_TOOL_DECLARATIONS, ...COMPUTER_TOOL_DECLARATIONS, ...WEB_TOOL_DECLARATIONS, ...INTERACTIVE_UI_TOOL_DECLARATIONS]) {
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
        // Typed file observations inherit the guard in the owning Office adapter;
        // raw paths without expectedRevision are rejected there before writing.
        expect(validate({ action: 'replace', path: 'file:17', content })).toBe(true);
    }
    expect(validate({ action: 'create', path: 'invalid.docx', content: { format: 'docx', sheets: [] } })).toBe(false);
});
it('publishes usable interaction examples through the original disclosure metadata', () => {
    const tool = extensionToolSchema(parseVarinExtensionServiceProvision(INTERACTIVE_UI_TOOL_DECLARATIONS[0]!));
    const validate = compileToolJsonSchema(tool.schema);
    const examples = tool.metadata?.examples as Array<{ arguments: { content?: unknown; changes?: unknown[] } }>;
    expect(examples.length).toBeGreaterThan(0);
    for (const example of examples) {
        expect(validate(example.arguments), JSON.stringify(validate.errors)).toBe(true);
        if (example.arguments.content) expect(() => normalizeConversationUi(example.arguments.content)).not.toThrow();
    }
    expect(validate({ content: { type: 'choice', options: ['A', 'B'], multiple: true, allowOther: true } })).toBe(true);
    expect(validate({ content: { type: 'form', fields: [{ type: 'input', label: 'Notes', inputType: 'textarea' }] } })).toBe(true);
    expect(validate({ content: { type: 'input', action: { type: 'execute_shell', label: 'Run' } } })).toBe(false);
});
