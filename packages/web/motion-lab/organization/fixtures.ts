import type { AgentSettingsSnapshot, ModelChannel } from '@varin/application-client';

const channel: ModelChannel = {
  id: 'openai', name: 'OpenAI', type: 'openai', enabled: true, baseUrl: '', authentication: { kind: 'none' }, parameters: {},
  models: [{ id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', enabled: true, operations: ['chat'], reasoning: true, input: ['text', 'image'] }],
};
const settings: AgentSettingsSnapshot = { global: { harness: { permissions: { mode: 'normal' } } }, globalRevision: 'design', project: {}, projectRevision: 'design', projectTrusted: false };

/** Supply the real model/settings readers with local fixtures, never a running user Host. */
export function installOrganizationFixtures(): () => void {
  const original = window.fetch;
  window.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (url.pathname.startsWith('/api/models/')) {
      if (url.pathname === '/api/models/read') return Response.json({ revision: 'design', channels: [channel], types: [] });
      if (url.pathname === '/api/models/settings/read') return Response.json(settings);
      if (url.pathname === '/api/models/settings/update') {
        const body = JSON.parse(String(init?.body ?? '{}'));
        Object.assign(settings.global, body.set);
        return Response.json(settings);
      }
    }
    if (url.pathname.startsWith('/api/')) return Response.json({ message: 'The design preview is not connected to an Application Host.' }, { status: 503 });
    return original(input, init);
  };
  return () => { window.fetch = original; };
}
