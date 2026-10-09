import { defineHostExtension, provideRetrievalPlan } from '@varin/extension-sdk';

export default defineHostExtension({
  activate(context) {
    provideRetrievalPlan(context, { configurationId: 'keyword-only-v1', structure: 'disabled' });
  },
});
