import { defineHostExtension, provideRetrievalPlan } from '@varin/extension-sdk';

export default defineHostExtension({
  activate(context) {
    provideRetrievalPlan(context, { configurationId: 'keyword-structure-v1', structure: 'builtin', semantic: 'disabled' });
  },
});
