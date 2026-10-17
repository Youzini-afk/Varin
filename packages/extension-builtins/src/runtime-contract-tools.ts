import {
  VARIN_RUNTIME_CONTRACT_REQUEST_SCHEMA, VARIN_EXTENSION_PACKAGE_REQUEST_SCHEMA, type VarinExtensionServiceProvision,
} from '@varin/extension-contract';

export const VARIN_BUILTIN_RUNTIME_CONTRACTS_EXTENSION_ID = 'varin.builtin.runtime-contracts';
export const RUNTIME_CONTRACT_TOOL_DECLARATIONS: readonly VarinExtensionServiceProvision[] = [{
  id: 'varin.runtime.contract', version: 1,
  tool: {
    name: 'runtime_contract',
    description: 'Inspect Varin service contracts and UI slots for extension development. Read immutable package source using extensionId, selected/candidate slot, artifactIntegrity and a package-relative path from the contract. Source pages use UTF-8 byte offsets and return a continuation. For callable tools and their parameters, use tool_describe.',
    operation: 'read', completion: 'result',
    inputSchema: VARIN_RUNTIME_CONTRACT_REQUEST_SCHEMA,
    outputSchema: { type: 'object' },
  },
}];

export const EXTENSION_PACKAGE_TOOL_DECLARATION: VarinExtensionServiceProvision = {
  id: 'varin.extension.package', version: 1,
  tool: {
    name: 'extension_package', operation: 'effect', completion: 'result',
    description: 'Stage an extension package from a source-relative packagePath, or apply a reviewed candidate using the current catalog revision. First installation stays disabled until enabled in Extensions. Package dependencies must already be present. Apply returns durable installation status; activation is reported separately.',
    inputSchema: VARIN_EXTENSION_PACKAGE_REQUEST_SCHEMA, outputSchema: { type: 'object' },
  },
};
