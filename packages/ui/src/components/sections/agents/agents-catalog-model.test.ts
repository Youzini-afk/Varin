import { describe, expect, test } from 'vitest';
import type { PiAgentCatalogSnapshot } from '@varin/protocol';
import { filterAgentsCatalog } from './agents-catalog-model';

const catalog: PiAgentCatalogSnapshot = {
  agents: [
    {
      actions: [],
      description: 'Reviews changes',
      id: 'subagents:reviewer',
      kind: 'delegatable',
      name: 'reviewer',
      providerId: 'pi-subagents',
      source: { packageName: 'pi-subagents', scope: 'package' },
      status: 'available',
      model: 'openai/gpt-5',
    },
    {
      actions: [],
      description: 'Keeps project history',
      id: 'magic:historian',
      kind: 'internal',
      name: 'historian',
      providerId: 'magic-context',
      source: { scope: 'runtime' },
      status: 'disabled',
    },
  ],
  diagnostics: [],
  projectTrusted: true,
  providers: [
    { actions: [], available: true, description: 'Delegated roles', id: 'pi-subagents', label: 'Pi Subagents' },
    { actions: [], available: true, description: 'Internal memory roles', id: 'magic-context', label: 'Magic Context' },
  ],
};

describe('filterAgentsCatalog', () => {
  test('searches agent and provider facts without changing the catalog', () => {
    expect(filterAgentsCatalog(catalog, 'GPT-5', 'all', 'all').map((agent) => agent.name)).toEqual(['reviewer']);
    expect(filterAgentsCatalog(catalog, 'magic context', 'all', 'all').map((agent) => agent.name)).toEqual(['historian']);
    expect(catalog.agents).toHaveLength(2);
  });

  test('applies provider and status filters independently', () => {
    expect(filterAgentsCatalog(catalog, '', 'magic-context', 'all').map((agent) => agent.name)).toEqual(['historian']);
    expect(filterAgentsCatalog(catalog, '', 'all', 'available').map((agent) => agent.name)).toEqual(['reviewer']);
    expect(filterAgentsCatalog(catalog, '', 'pi-subagents', 'disabled')).toEqual([]);
  });
});
