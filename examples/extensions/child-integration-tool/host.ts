import { defineHostExtension, provideTool } from '@varin/extension-sdk';
import manifest from './varin.extension.json';

export default defineHostExtension({
  activate(context) {
    provideTool(context, manifest.provides.services[0], async (input, call) => (
      call.capabilities.call('collaboration.integrations', 'apply', input)
    ));
  },
});
