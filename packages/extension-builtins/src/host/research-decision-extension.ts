import { defineHostExtension, provideTool } from '@varin/extension-sdk';
import { RESEARCH_DECISION_CAPABILITY, RESEARCH_DECISION_TOOL_DECLARATIONS } from '../research-decision-tools.js';
export default defineHostExtension({ activate(context) {
  for (const service of RESEARCH_DECISION_TOOL_DECLARATIONS) {
    provideTool(context, service, (input, call) => call.capabilities.call(RESEARCH_DECISION_CAPABILITY, 'decide', input));
  }
} });
