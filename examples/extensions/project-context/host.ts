import { defineHostExtension, provideContextFragments } from '@varin/extension-sdk';

export default defineHostExtension({
  activate(context) {
    provideContextFragments(context, { sections: [{
      name: 'research-evidence', kind: 'instruction',
      content: 'For this project, distinguish evidence from hypotheses. When reporting experiments, state the measured result and the comparison baseline. Never fabricate measurements.',
    }] });
  },
});
