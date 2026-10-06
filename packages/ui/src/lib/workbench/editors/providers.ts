import {
  BUILTIN_EDITOR_PROVIDER_IDS,
  type EditorProviderContribution,
  type EditorProviderSelection,
} from './types';
import { languageIdFromResourceId } from '@/lib/language-services/language-id';

const extensionOf = (resourceId: string): string => {
  const name = resourceId.split('/').pop() ?? resourceId;
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
};

const matches = (provider: EditorProviderContribution, resourceId: string): boolean => {
  const fileName = resourceId.split('/').pop() ?? resourceId;
  if (provider.filenames?.some((name) => name === fileName)) return true;
  const extension = extensionOf(resourceId);
  const languageId = languageIdFromResourceId(resourceId);
  return Boolean(provider.languages?.some((language) => language === extension || language === languageId));
};

export const BUILTIN_EDITOR_PROVIDERS: EditorProviderContribution[] = [
  { id: BUILTIN_EDITOR_PROVIDER_IDS.browser, extensionId: 'varin.builtin.editors', enabled: true, priority: 0 },
  {
    id: BUILTIN_EDITOR_PROVIDER_IDS.markdown,
    extensionId: 'varin.builtin.editors',
    enabled: true,
    languages: ['md', 'markdown'],
    priority: 20,
  },
  {
    id: BUILTIN_EDITOR_PROVIDER_IDS.json,
    extensionId: 'varin.builtin.editors',
    enabled: true,
    languages: ['json', 'jsonc', 'json5', 'geojson'],
    priority: 20,
  },
  {
    id: BUILTIN_EDITOR_PROVIDER_IDS.html,
    extensionId: 'varin.builtin.editors',
    enabled: true,
    languages: ['html', 'htm'],
    priority: 20,
  },
  {
    id: BUILTIN_EDITOR_PROVIDER_IDS.drawio,
    extensionId: 'varin.builtin.editors',
    enabled: true,
    languages: ['drawio', 'dio'],
    priority: 20,
  },
  {
    id: BUILTIN_EDITOR_PROVIDER_IDS.image,
    extensionId: 'varin.builtin.editors',
    enabled: true,
    languages: ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp', 'avif'],
    priority: 20,
  },
  {
    id: BUILTIN_EDITOR_PROVIDER_IDS.pdf,
    extensionId: 'varin.builtin.editors',
    enabled: true,
    languages: ['pdf'],
    priority: 20,
  },
  {
    id: BUILTIN_EDITOR_PROVIDER_IDS.diff,
    extensionId: 'varin.builtin.editors',
    enabled: true,
    languages: ['diff', 'patch'],
    priority: 20,
  },
  {
    // Declares no languages and no fallback, so `matches` never returns true and resolution never
    // selects it. Reachable only through an explicit, pinned provider request.
    id: BUILTIN_EDITOR_PROVIDER_IDS.gitDiff,
    extensionId: 'varin.builtin.editors',
    enabled: true,
    priority: 0,
  },
  {
    id: BUILTIN_EDITOR_PROVIDER_IDS.text,
    extensionId: 'varin.builtin.editors',
    enabled: true,
    priority: 0,
    fallback: true,
  },
];

const extraProviders = new Map<string, EditorProviderContribution>();
const disabledIds = new Set<string>();
const userAssociations = new Map<string, string>();
const listeners = new Set<() => void>();
let revision = 0;

const emitProviders = (): void => {
  revision += 1;
  for (const listener of listeners) listener();
};

export const subscribeEditorProviders = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const getEditorProvidersRevision = (): number => revision;

export const registerEditorProvider = (provider: EditorProviderContribution): (() => void) => {
  extraProviders.set(provider.id, provider);
  emitProviders();
  return () => {
    extraProviders.delete(provider.id);
    emitProviders();
  };
};

export const setEditorProviderEnabled = (providerId: string, enabled: boolean): void => {
  if (enabled) disabledIds.delete(providerId);
  else disabledIds.add(providerId);
  emitProviders();
};

export const isEditorProviderEnabled = (providerId: string): boolean => !disabledIds.has(providerId);

export const setUserEditorAssociation = (resourceId: string, providerId: string): void => {
  userAssociations.set(resourceId, providerId);
  emitProviders();
};

export const clearUserEditorAssociation = (resourceId: string): void => {
  userAssociations.delete(resourceId);
  emitProviders();
};

export const getUserEditorAssociation = (resourceId: string): string | undefined => (
  userAssociations.get(resourceId)
);

export const listEditorProviders = (): EditorProviderContribution[] => {
  const byId = new Map<string, EditorProviderContribution>();
  for (const provider of BUILTIN_EDITOR_PROVIDERS) {
    byId.set(provider.id, {
      ...provider,
      enabled: provider.enabled && !disabledIds.has(provider.id),
    });
  }
  for (const provider of extraProviders.values()) {
    byId.set(provider.id, {
      ...provider,
      enabled: provider.enabled && !disabledIds.has(provider.id),
    });
  }
  return [...byId.values()];
};

export const resetEditorProvidersForTests = (): void => {
  extraProviders.clear();
  disabledIds.clear();
  userAssociations.clear();
  emitProviders();
};

export const selectEditorProvider = (
  resourceId: string,
  providers: EditorProviderContribution[] = listEditorProviders(),
  userAssociation?: string,
): EditorProviderSelection => {
  const enabled = providers.filter((provider) => provider.enabled);
  const association = userAssociation ?? userAssociations.get(resourceId);
  if (association) {
    const associated = enabled.find((provider) => provider.id === association);
    if (associated) return { status: 'selected', providerId: associated.id };
  }

  const candidates = enabled
    .filter((provider) => matches(provider, resourceId))
    .sort((left, right) => right.priority - left.priority);

  if (candidates.length > 0) {
    const top = candidates[0]?.priority;
    const tied = candidates.filter((provider) => provider.priority === top).map((provider) => provider.id);
    if (tied.length > 1) return { status: 'ambiguous', providerIds: tied };
    const selected = tied[0];
    return selected ? { status: 'selected', providerId: selected } : { status: 'none' };
  }

  const fallback = enabled
    .filter((provider) => provider.fallback === true)
    .sort((left, right) => right.priority - left.priority)[0];
  return fallback ? { status: 'selected', providerId: fallback.id } : { status: 'none' };
};

export const resolveEditorProviderId = (resourceId: string): string => {
  const selection = selectEditorProvider(resourceId);
  if (selection.status === 'selected') return selection.providerId;
  if (selection.status === 'ambiguous') return selection.providerIds[0] ?? BUILTIN_EDITOR_PROVIDER_IDS.text;
  return BUILTIN_EDITOR_PROVIDER_IDS.text;
};
