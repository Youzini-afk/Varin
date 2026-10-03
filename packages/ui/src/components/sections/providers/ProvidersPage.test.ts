import { describe, expect, test } from 'vitest';
import type { ProviderConfigDetails } from '@varin/protocol';
import {
  buildProviderSourcesFromDetails,
  canEditProviderFromDetails,
  editableProviderFromDetails,
} from './providerDetailConfig';

const details = (overrides: Partial<ProviderConfigDetails> = {}): ProviderConfigDetails => ({
  auth: { configured: true, label: 'Stored API key', source: 'stored' },
  config: {
    api: 'openai-completions',
    baseUrl: 'http://localhost:11434/v1',
    id: 'local',
    models: [],
  },
  effectiveScope: 'project',
  locations: {
    custom: { available: false, exists: false, scope: 'custom', writable: false },
    project: { available: true, exists: true, path: 'C:/repo/.pi/models.json', scope: 'project', writable: true },
    user: { available: true, exists: false, path: 'C:/agent/models.json', scope: 'user', writable: true },
  },
  providerId: 'local',
  ...overrides,
});

describe('Pi provider settings details', () => {
  test('maps canonical host provenance directly into UI sources', () => {
    expect(buildProviderSourcesFromDetails(details())).toEqual({
      auth: { exists: true },
      custom: { exists: false, path: null },
      project: { exists: true, path: 'C:/repo/.pi/models.json' },
      user: { exists: false, path: 'C:/agent/models.json' },
    });
  });

  test('builds an editable Pi form only when host-owned config exists', () => {
    const editable = editableProviderFromDetails(details());
    expect(canEditProviderFromDetails(details())).toBe(true);
    expect(editable?.api).toBe('openai-completions');
    expect(editable?.baseURL).toBe('http://localhost:11434/v1');
    expect(editable?.id).toBe('local');
    expect(editable?.scope).toBe('project');

    const full = details();
    const authOnly: ProviderConfigDetails = {
      auth: full.auth,
      locations: full.locations,
      providerId: full.providerId,
    };
    expect(canEditProviderFromDetails(authOnly)).toBe(false);
    expect(editableProviderFromDetails(authOnly)).toBeNull();
  });
});
