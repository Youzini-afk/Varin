import { defineHostExtension, provideTool } from '@varin/extension-sdk';
import { WEB_CAPABILITY, WEB_TOOL_DECLARATIONS } from '../web-tools.js';

export default defineHostExtension({ activate(context) {
  for (const service of WEB_TOOL_DECLARATIONS) {
    const method = service.id.slice('varin.web.'.length);
    provideTool(context, service, (input, call) => call.capabilities.call(WEB_CAPABILITY, method, input));
  }
} });
