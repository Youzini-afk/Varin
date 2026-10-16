import { defineHostExtension, provideTool } from '@varin/extension-sdk';
import { INTERACTIVE_UI_CAPABILITY, INTERACTIVE_UI_TOOL_DECLARATIONS } from '../interactive-ui-tools.js';
export default defineHostExtension({ activate(context) {
  for (const service of INTERACTIVE_UI_TOOL_DECLARATIONS) provideTool(context, service,
    (input, call) => call.capabilities.call(INTERACTIVE_UI_CAPABILITY, 'render', input));
} });
