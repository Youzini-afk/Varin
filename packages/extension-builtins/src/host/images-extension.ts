import { defineHostExtension, provideTool } from '@varin/extension-sdk';
import { IMAGES_CAPABILITY, IMAGE_TOOL_DECLARATIONS } from '../image-tools.js';
export default defineHostExtension({ activate(context) {
  for (const service of IMAGE_TOOL_DECLARATIONS) provideTool(context, service,
    (input, call) => call.capabilities.call(IMAGES_CAPABILITY, service.id.slice('varin.images.'.length), input));
} });
