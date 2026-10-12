import { defineHostExtension, provideTool } from '@varin/extension-sdk';
import { parseVarinRuntimeInspectionRequest, parseVarinToolJson, VARIN_RUNTIME_CONTRACTS_CAPABILITY } from '@varin/extension-contract';
import { RUNTIME_CONTRACT_TOOL_DECLARATIONS } from '../runtime-contract-tools.js';

export default defineHostExtension({ activate(context) {
  for (const service of RUNTIME_CONTRACT_TOOL_DECLARATIONS) {
    provideTool(context, service, async (input, call) => {
      const query = parseVarinRuntimeInspectionRequest(input);
      if (query.kind === 'tool') return parseVarinToolJson(query.action === 'list'
        ? await call.tools.list() : await call.tools.describe(query.name));
      return call.capabilities.call(VARIN_RUNTIME_CONTRACTS_CAPABILITY, 'query', input);
    });
  }
} });
