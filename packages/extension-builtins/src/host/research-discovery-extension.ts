import { defineHostExtension, provideTool } from '@varin/extension-sdk';
import { RESEARCH_DISCOVERY_CAPABILITY, RESEARCH_DISCOVERY_TOOL_DECLARATIONS } from '../research-discovery-tools.js';

export default defineHostExtension({ activate(context) {
  for (const service of RESEARCH_DISCOVERY_TOOL_DECLARATIONS) {
    const method = service.id.slice('varin.research.'.length);
    provideTool(context, service, (input, call) => call.capabilities.call(RESEARCH_DISCOVERY_CAPABILITY, method, input));
  }
} });
