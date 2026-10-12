import { defineHostExtension, provideContextFragments } from '@varin/extension-sdk';

export default defineHostExtension({
  activate(context) {
    provideContextFragments(context, { sections: [{
      name: 'execution-reporting', kind: 'instruction',
      content: 'Distinguish completed work, attempted work, and proposed next steps. Preserve uncertainty when an operation has no confirmed outcome. Describe a missing capability honestly.',
    }] });
  },
});
