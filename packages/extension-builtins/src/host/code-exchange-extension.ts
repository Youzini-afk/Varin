import { defineHostExtension, provideTool } from '@varin/extension-sdk';
import { CODE_EXCHANGE_CAPABILITY, CODE_EXCHANGE_TOOL_DECLARATIONS } from '../code-exchange-tools.js';

export default defineHostExtension({ activate(context) {
  for (const service of CODE_EXCHANGE_TOOL_DECLARATIONS) {
    provideTool(context, service, (input, call) => call.capabilities.call(
      CODE_EXCHANGE_CAPABILITY, service.id.slice('varin.code.'.length), input));
  }
} });
