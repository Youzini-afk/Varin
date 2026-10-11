import { defineHostExtension, provideTool } from '@varin/extension-sdk';
import { COMPUTER_CAPABILITY, COMPUTER_TOOL_DECLARATIONS } from '../computer-tools.js';

export default defineHostExtension({ activate(context) {
  for (const service of COMPUTER_TOOL_DECLARATIONS) {
    const method = service.id.slice('varin.computer.'.length);
    provideTool(context, service, (input, call) => call.capabilities.call(COMPUTER_CAPABILITY, method, input));
  }
} });
