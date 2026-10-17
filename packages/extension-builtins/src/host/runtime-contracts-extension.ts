import { SETTINGS_CAPABILITY, SETTINGS_TOOL_DECLARATIONS } from '../settings-tools.js';
import { defineHostExtension, provideTool } from '@varin/extension-sdk';
import { parseVarinRuntimeContractRequest, VARIN_RUNTIME_CONTRACTS_CAPABILITY, VARIN_EXTENSION_PACKAGES_CAPABILITY } from '@varin/extension-contract';
import { RUNTIME_CONTRACT_TOOL_DECLARATIONS, EXTENSION_PACKAGE_TOOL_DECLARATION } from '../runtime-contract-tools.js';

export default defineHostExtension({ activate(context) {
  for (const service of SETTINGS_TOOL_DECLARATIONS) provideTool(context, service, (input, call) => call.capabilities.call(SETTINGS_CAPABILITY, service.id.slice('varin.settings.'.length), input));
  provideTool(context, EXTENSION_PACKAGE_TOOL_DECLARATION, (input, call) => call.capabilities.call(VARIN_EXTENSION_PACKAGES_CAPABILITY, "manage", input));
  for (const service of RUNTIME_CONTRACT_TOOL_DECLARATIONS) {
    provideTool(context, service, async (input, call) => {
      parseVarinRuntimeContractRequest(input);
      return call.capabilities.call(VARIN_RUNTIME_CONTRACTS_CAPABILITY, 'query', input);
    });
  }
} });
