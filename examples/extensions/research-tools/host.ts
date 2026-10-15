import { defineHostExtension, provideTool } from '@varin/extension-sdk';
import manifest from './varin.extension.json';
export default defineHostExtension({ activate(context) {
  for (const service of manifest.provides.services) {
    const method = service.id.slice('example.research.'.length);
    provideTool(context, service, (input, call) => call.capabilities.call('research.experiments', method, input));
  }
} });
