import { defineHostExtension, provideTool } from '@varin/extension-sdk';
import { ENVIRONMENT_FORWARD_CAPABILITY, ENVIRONMENT_FORWARD_TOOL_DECLARATIONS } from '../environment-forward-tools.js';
export default defineHostExtension({ activate(context) {
  for (const service of ENVIRONMENT_FORWARD_TOOL_DECLARATIONS) {
    const method = service.id.slice('varin.environment.'.length);
    provideTool(context, service, (input, call) => call.capabilities.call(ENVIRONMENT_FORWARD_CAPABILITY, method, input));
  }
} });
