// Data for the real product components. The capture server never connects to a user Host.
export const modelChannel = {
  id: 'deepseek', name: 'DeepSeek', type: 'deepseek', enabled: true,
  baseUrl: 'https://api.deepseek.com', authentication: { kind: 'none' }, parameters: {},
  models: [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', enabled: true, operations: ['chat'], input: ['text', 'image'], reasoning: true }],
};
export const responses = {
  '/api/models/read': { revision: 'readme', channels: [modelChannel], types: [], issues: [] },
  '/api/models/settings/read': { global: { harness: { permissions: { mode: 'normal' } } }, globalRevision: 'readme', project: {}, projectRevision: 'readme', projectTrusted: false },
  '/api/external-agents/settings': { revision: 1, defaultAgent: null, agents: [] },
  '/api/external-agents/list': [],
  '/api/external-agents/children': [],
  '/api/interactive-ui/view/attach': { viewRef: 'ui-view:readme-estimate', token: 'readme', state: null },
  '/api/interactive-ui/view/state': { saved: true },
  '/api/interactive-ui/view/detach': { closed: true },
};
