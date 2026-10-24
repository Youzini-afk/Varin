import { defineHostExtension, provideTool } from '@varin/extension-sdk';
import { BROWSER_CAPABILITY, BROWSER_TOOL_DECLARATIONS } from '../browser-tools.js';

export default defineHostExtension({ activate(context) {
  for (const service of BROWSER_TOOL_DECLARATIONS) {
    provideTool(context, service, (input, call) => call.capabilities.call(BROWSER_CAPABILITY, service.id.slice('varin.browser.'.length), input));
  }
} });
