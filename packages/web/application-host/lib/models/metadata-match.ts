/** Match model identities, never display names or connection/authentication settings. */
import type { ChannelModel, DiscoveredModel, ModelMetadataRequest } from '@varin/application-client';
import type { ChannelType, ChannelTypes } from './channel-types.js';
import { directoryModels, metadataProviderId } from './directory-models.js';
import { object } from './configuration.js';

const metadataFields = ['contextWindow', 'maxOutputTokens', 'input', 'reasoning', 'thinking', 'thinkingLevelMap', 'tokenizer', 'compat'] as const;
const modelCompat = ['thinkingFormat', 'supportsReasoningEffort', 'forceAdaptiveThinking', 'supportsMidConvoEffort', 'requiresReasoningContentOnAssistantMessages', 'maxTokensField'] as const;
type Metadata = Pick<ChannelModel, typeof metadataFields[number]>;
type Entry = { provider: string; owner: string; canonical: string; model: ChannelModel };

// A numeric dot belongs to a version: gpt-4.2 must not match gpt-4.
const normalize = (id: string) => id.trim().toLowerCase().replace(/(?<!\d)\.|\.(?!\d)/g, '-')
  .replace(/[^\p{L}\p{N}.]+/gu, '-').replace(/^-+|-+$/g, '');
const lookupId = (id: string) => id.match(/(?:^|[^a-z0-9])ft:([^:]+)/i)?.[1] ?? id;
const metadata = (model: DiscoveredModel): Metadata => Object.fromEntries(metadataFields
  .filter(field => model[field] !== undefined).map(field => [field, field === 'compat'
    ? Object.fromEntries(modelCompat.filter(key => model.compat?.[key] !== undefined).map(key => [key, model.compat![key]])) : model[field]]));

class IdentityIndex<T> {
  readonly aliases = new Map<string, Set<T>>();
  add(alias: string, value: T) {
    const key = normalize(alias); if (!key) return;
    let values = this.aliases.get(key); if (!values) this.aliases.set(key, values = new Set());
    values.add(value);
  }
  match(id: string): T[] {
    const tokens = normalize(lookupId(id)).split('-');
    const matches: Array<{ start: number; end: number; values: T[] }> = [];
    for (let start = 0; start < tokens.length; start++) {
      let key = '';
      for (let end = start; end < tokens.length; end++) {
        key += (end === start ? '' : '-') + tokens[end];
        const values = [...(this.aliases.get(key) ?? [])];
        if (values.length) matches.push({ start, end, values });
      }
    }
    // Keep the specific variant at each position. Separate model names remain ambiguous.
    return [...new Set(matches.filter(match => !matches.some(other => other !== match
      && other.start <= match.start && other.end >= match.end && (other.start < match.start || other.end > match.end)))
      .flatMap(match => match.values))];
  }
}

/** Built once per directory generation; repeated binding preparation does no catalog scanning. */
export class ModelMetadataIndex {
  readonly #index = new IdentityIndex<Entry>();
  readonly #canonical = new Map<string, Entry[]>();
  readonly #cache = new Map<string, Metadata | undefined>();
  constructor(data: Record<string, unknown>, types: ChannelTypes) {
    const installed = types.entries();
    const fallback = types.get('openai-compatible')!;
    for (const [providerId, provider] of Object.entries(data)) {
      if (!object(provider) || !object(provider.models)) continue;
      const type = installed.find(type => metadataProviderId(type) === providerId) ?? {
        ...fallback, id: providerId, metadataId: providerId,
        protocols: ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'],
      };
      for (const model of directoryModels(data, type) ?? []) {
        const raw = provider.models[model.id]; if (!object(raw)) continue;
        const canonical = typeof raw.canonical_model_id === 'string' ? raw.canonical_model_id : `${providerId}/${model.id}`;
        const entry = { provider: providerId, owner: canonical.split('/')[0]!, canonical: normalize(canonical), model };
        const group = this.#canonical.get(entry.canonical) ?? [];
        group.push(entry); this.#canonical.set(entry.canonical, group);
        for (const alias of [model.id, `${providerId}/${model.id}`, canonical, canonical.slice(canonical.indexOf('/') + 1)]) this.#index.add(alias, entry);
      }
    }
  }
  lookup(type: ChannelType, request: ModelMetadataRequest): Metadata | undefined {
    const id = request.requestModelId ?? request.id, provider = metadataProviderId(type), protocol = request.protocol ?? type.protocol;
    const key = JSON.stringify([provider, protocol, id]);
    if (this.#cache.has(key)) return this.#cache.get(key);
    const matches = this.#index.match(id);
    const scoped = matches.filter(entry => entry.provider === provider);
    const relevant = scoped.length ? scoped : matches;
    let result: Metadata | undefined;
    if (relevant.length && new Set(relevant.map(entry => entry.canonical)).size === 1) {
      const group = this.#canonical.get(relevant[0]!.canonical)!;
      // Prefer the model owner's facts over unrelated resellers' limits. When the owner is
      // absent, inherit only facts on which the matching records agree.
      const owns = (entry: Entry) => normalize(entry.provider) === normalize(entry.owner);
      const owners = matches.filter(owns);
      const canonicalOwners = group.filter(owns);
      const sources = scoped.length ? scoped : owners.length ? owners : canonicalOwners.length ? canonicalOwners : matches;
      const values: Metadata = {};
      for (const field of metadataFields) {
        if ((field === 'thinkingLevelMap' || field === 'compat') && sources.some(entry => entry.model.protocol !== protocol)) continue;
        const value = metadata(sources[0]!.model)[field];
        if (value !== undefined && sources.every(entry => JSON.stringify(metadata(entry.model)[field]) === JSON.stringify(value))) {
          Object.assign(values, { [field]: structuredClone(value) });
        }
      }
      if (Object.keys(values).length) result = values;
    }
    this.#cache.set(key, result);
    return result;
  }
}

const indexes = new WeakMap<readonly ChannelModel[], Map<string, ChannelModel[]>>();
function scopedMatch(models: readonly ChannelModel[], id: string) {
  let index = indexes.get(models);
  if (!index) {
    index = new Map();
    for (const model of models) {
      const key = normalize(model.requestModelId ?? model.id);
      index.set(key, [...(index.get(key) ?? []), model]);
    }
    indexes.set(models, index);
  }
  const matches = index.get(normalize(id));
  return matches?.length === 1 ? matches[0] : undefined;
}

export function modelDirectoryDefaults(index: ModelMetadataIndex, type: ChannelType, request: ModelMetadataRequest, directory: readonly ChannelModel[]): ChannelModel | undefined {
  const id = request.requestModelId ?? request.id;
  const local = scopedMatch(directory, id);
  if (local && (local.requestModelId ?? local.id) === id && request.id === local.id) return local;
  const inferred = index.lookup(type, request);
  if (!local && !inferred) return undefined;
  const scopedMetadata = local ? metadata(local) : {};
  if (local?.protocol !== (request.protocol ?? type.protocol)) { delete scopedMetadata.compat; delete scopedMetadata.thinkingLevelMap; }
  return { ...inferred, ...scopedMetadata, id: request.id, name: request.id, enabled: false,
    operations: request.operations ?? ['chat'],
    ...(request.requestModelId === undefined ? {} : { requestModelId: request.requestModelId }),
    ...(request.protocol === undefined ? {} : { protocol: request.protocol }),
    catalog: { ...local?.catalog, overrides: [] } };
}
