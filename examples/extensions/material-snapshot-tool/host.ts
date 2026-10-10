import { defineHostExtension, provideTool } from '@varin/extension-sdk';
import manifest from './varin.extension.json';

export default defineHostExtension({
  activate(context) {
    provideTool(context, manifest.provides.services[0], async (input, call) => {
      // The Host attaches the admitted original Run/Thread/source authority to this call.
      // The extension supplies only material identity and a byte range, never authority IDs.
      return call.capabilities.call('materials.snapshot', 'read', input);
    });
  },
});
