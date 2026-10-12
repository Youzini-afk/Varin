import {
  VARIN_RUNTIME_INSPECTION_REQUEST_SCHEMA, type VarinExtensionServiceProvision,
} from '@varin/extension-contract';

export const VARIN_BUILTIN_RUNTIME_CONTRACTS_EXTENSION_ID = 'varin.builtin.runtime-contracts';
export const RUNTIME_CONTRACT_TOOL_DECLARATIONS: readonly VarinExtensionServiceProvision[] = [{
  id: 'varin.runtime.contract', version: 1,
  tool: {
    name: 'runtime_contract',
    description: 'List or describe tools frozen in this invocation, current service methods/events, or UI slot props. Tool queries use the original accepted Run directory; service and UI queries read current metadata without activating extensions. Selection and declarations do not grant execution permission. Missing metadata stays undeclared. Source locations are package-relative and do not read source code.',
    operation: 'read', completion: 'result',
    inputSchema: VARIN_RUNTIME_INSPECTION_REQUEST_SCHEMA,
    outputSchema: { type: 'object' },
  },
}];
