async function (fixture) {
  try {
    const base = new URL(window.__VARIN_API_BASE_URL__);
    if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || !base.port || base.username || base.password) return { failed: true };
    const api = async (route, body) => {
      const response = await fetch(new URL(route, base), { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${window.__VARIN_CLIENT_TOKEN__}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error('Synthetic readback failed');
      return response.json();
    };
    const [snapshot, settings, models, agent, run] = await Promise.all([api('/api/threads/snapshot', fixture.identity), api('/api/config/settings'), api('/api/models/read', {}), api('/api/models/settings/read', {}), api('/api/threads/run', { runId: fixture.runId })]);
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(snapshot.history))))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    const channel = models.channels?.find(entry => entry.id === fixture.channelId);
    return { chatHistoryPreserved: snapshot.historyPage?.head === fixture.head && digest === fixture.historySha256,
      completedRunPreserved: run.state === 'completed',
      projectRegistrationPreserved: settings.projects?.some(entry => entry.id === fixture.project.id && entry.path === fixture.project.path && entry.label === fixture.project.label) === true && settings.activeProjectId === fixture.project.id,
      hostSettingsPreserved: settings.fontSize === 113 && settings.autoSaveEnabled === false,
      modelCredentialBindingPreserved: channel?.authentication?.kind === 'credential' && channel.authentication.reference === fixture.credentialReference && agent.global?.defaultProvider === fixture.channelId && agent.global?.defaultModel === fixture.modelId,
      source: 'installed-authenticated-host-and-original-rust-owner', valuesDisclosed: false };
  } catch { return { failed: true }; }
}
