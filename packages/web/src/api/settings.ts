import type { SettingsAPI, SettingsLoadResult, SettingsPayload } from '@varin/application-client';
import { runtimeFetch } from '@varin/application-client';

const SETTINGS_ENDPOINT = '/api/config/settings';

const sanitizePayload = (data: unknown): SettingsPayload => {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid settings response');
  return data as SettingsPayload;
};

export const createWebSettingsAPI = (): SettingsAPI => ({
  async load(): Promise<SettingsLoadResult> {
    const response = await runtimeFetch(SETTINGS_ENDPOINT, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      throw new Error(`Failed to load settings: ${response.statusText}`);
    }

    const payload = sanitizePayload(await response.json());
    return {
      settings: payload,
      source: 'web',
    };
  },

  async save(changes: Partial<SettingsPayload>): Promise<SettingsPayload> {
    const response = await runtimeFetch(SETTINGS_ENDPOINT, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(changes),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(error.error || 'Failed to save settings');
    }

    const payload = sanitizePayload(await response.json());
    return payload;
  },

  async changeWorkspaceLocation(change, signal) {
    const response = await runtimeFetch(`${SETTINGS_ENDPOINT}/workspace-location`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(change),
      ...(signal ? { signal } : {}),
    });
    const result = await response.json().catch(() => ({}));
    if (response.status === 409 && (result.conflict === 'duplicate' || result.conflict === 'stale')) {
      return { settings: sanitizePayload(result.settings), conflict: result.conflict };
    }
    if (!response.ok) throw new Error(result.error || 'Failed to save workspace location');
    return { settings: sanitizePayload(result.settings) };
  },
});
