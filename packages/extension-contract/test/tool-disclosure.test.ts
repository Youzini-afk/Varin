import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parseVarinExtensionToolDeclaration } from '../src/tools.js';
test('tool navigation retains the original contract and validates explicit branch addresses', () => {
    const declaration = { name: 'external_operation', description: 'Operate a retained object.', completion: 'result', operation: 'effect',
        inputSchema: { type: 'object', required: ['source'], properties: { source: { type: 'string' } }, oneOf: [{ required: ['a'] }, { required: ['b'] }] }, outputSchema: { type: 'object' },
        disclosure: { summary: 'Read or change an object.', aliases: ['对象'], namespace: 'custom', operations: [{ name: 'a', description: 'Read branch a.', paths: ['/oneOf/0'] }] } };
    assert.deepEqual(parseVarinExtensionToolDeclaration(declaration), declaration);
    assert.throws(() => parseVarinExtensionToolDeclaration({ ...declaration, disclosure: { ...declaration.disclosure, operations: [{ name: 'bad', description: 'Missing branch.', paths: ['/oneOf/9'] }] } }), /existing/);
    assert.throws(() => parseVarinExtensionToolDeclaration({ ...declaration, disclosure: { ...declaration.disclosure, operations: [{ name: 'bad', description: 'Arbitrary subtree.', paths: ['/properties/source'] }] } }), /existing/);
    const { disclosure: _disclosure, ...ordinary } = declaration;
    assert.equal(parseVarinExtensionToolDeclaration(ordinary).disclosure, undefined);
});
