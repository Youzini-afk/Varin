import { defineHostExtension, provideTool } from '@varin/extension-sdk';
import manifest from './varin.extension.json';
export default defineHostExtension({
  activate(context) {
    provideTool(context, manifest.provides.services[0], (input, call) => call.capabilities.call('tasks.schedules', 'manage', input));
  },
});
