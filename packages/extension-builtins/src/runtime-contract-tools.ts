import {
  VARIN_RUNTIME_INSPECTION_REQUEST_SCHEMA, VARIN_EXTENSION_PACKAGE_REQUEST_SCHEMA, type VarinExtensionServiceProvision,
} from '@varin/extension-contract';

export const VARIN_BUILTIN_RUNTIME_CONTRACTS_EXTENSION_ID = 'varin.builtin.runtime-contracts';
export const RUNTIME_CONTRACT_TOOL_DECLARATIONS: readonly VarinExtensionServiceProvision[] = [{
  id: 'varin.runtime.contract', version: 1,
  tool: {
    name: 'runtime_contract',
    description: 'List or describe tools frozen in this invocation, current service methods/events, or UI slot props. Tool queries use the original accepted Run directory; service and UI queries read current metadata without activating extensions. Selection and declarations do not grant execution permission. Missing metadata stays undeclared. Explicit source reads require extensionId, current selected/candidate slot, exact artifactIntegrity and a package-relative path. They read verified immutable UTF-8 pages without activation or preparing missing packages. Offsets are UTF-8 byte boundaries; completing a final code point may exceed maxBytes by up to three bytes. Ordinary source text never grants authority.',
    operation: 'read', completion: 'result',
    inputSchema: VARIN_RUNTIME_INSPECTION_REQUEST_SCHEMA,
    outputSchema: { type: 'object' },
  },
}];

export const EXTENSION_PACKAGE_TOOL_DECLARATION: VarinExtensionServiceProvision = {
  id: 'varin.extension.package', version: 1,
  tool: {
    name: 'extension_package', operation: 'effect', completion: 'result',
    description: 'Stage an extension package from packagePath inside this Run’s admitted source, or apply an exact reviewed candidate. Read the current extension catalog revision first. First installation is always disabled until the user enables it and reviews requested capabilities in Extensions. Updates preserve existing enablement and capability decisions; apply cannot grant capabilities or enable a new extension. Apply records durable intent before preparing the candidate, so cancellation after application_requested can still be resumed on restart. selected reports installed content selection; actual Host/Surface activation is reported separately. Package paths are source-relative; source capture is required only for stage. Missing build dependencies must be provided in the package or prebuilt entrypoint; none are installed automatically.',
    inputSchema: VARIN_EXTENSION_PACKAGE_REQUEST_SCHEMA, outputSchema: { type: 'object' },
  },
};
