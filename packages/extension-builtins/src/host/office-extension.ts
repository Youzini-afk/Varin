import { defineHostExtension, provideTool } from '@varin/extension-sdk';
import { OFFICE_CAPABILITY, OFFICE_TOOL_DECLARATIONS } from '../office-tools.js';

export default defineHostExtension({ activate(context) {
  for (const service of OFFICE_TOOL_DECLARATIONS) {
    provideTool(context, service, (input, call) => call.capabilities.call(OFFICE_CAPABILITY, service.id.slice('varin.office.'.length), input));
  }
} });
