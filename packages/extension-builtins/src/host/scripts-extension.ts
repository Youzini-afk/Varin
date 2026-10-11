import { defineHostExtension, provideTool } from '@varin/extension-sdk';
import { SCRIPT_CAPABILITY, SCRIPT_TOOL_DECLARATIONS } from '../script-tools.js';
export default defineHostExtension({ activate(context) {
  for (const service of SCRIPT_TOOL_DECLARATIONS) {
    const method = service.id.slice('varin.script.'.length);
    provideTool(context, service, (input, call) => call.capabilities.call(SCRIPT_CAPABILITY, method, input));
  }
} });
