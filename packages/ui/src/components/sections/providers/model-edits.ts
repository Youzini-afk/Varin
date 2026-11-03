import { applyModelDirectoryDefaults, MODEL_CATALOG_FIELDS, type ChannelModel, type ChannelTypeInfo, type DiscoveredModel, type ModelCatalogField } from '@varin/application-client';

export function editModel(previous: ChannelModel, patch: Partial<ChannelModel>, defaults?: ChannelModel): ChannelModel {
  const baseline = applyModelDirectoryDefaults(previous, defaults);
  let model = { ...baseline, ...patch };
  if (baseline.catalog) {
    const changed = MODEL_CATALOG_FIELDS.filter(field => Object.hasOwn(patch, field));
    model = { ...model, catalog: { ...baseline.catalog,
      match: baseline.catalog.match ?? { requestModelId: previous.requestModelId ?? previous.id, ...(previous.protocol ? { protocol: previous.protocol } : {}) },
      overrides: [...new Set([...baseline.catalog.overrides, ...changed])] } };
    if (Object.hasOwn(patch, 'tokenizer') && patch.tokenizer === undefined) {
      model.tokenizer = defaults?.tokenizer ? structuredClone(defaults.tokenizer) : undefined;
      model.catalog!.overrides = model.catalog!.overrides.filter(field => field !== 'tokenizer');
    }
  }
  const identityChanged = (model.requestModelId ?? model.id) !== (previous.requestModelId ?? previous.id) || model.protocol !== previous.protocol;
  return applyModelDirectoryDefaults(model, identityChanged ? undefined : defaults);
}

export function modelCandidates(type: ChannelTypeInfo, discovered: DiscoveredModel[]) {
  return [...discovered, ...(type.catalog ?? []).filter(model => !discovered.some(candidate => candidate.id === model.id))];
}

export function followModel(model: ChannelModel, defaults: ChannelModel, field?: ModelCatalogField): ChannelModel {
  if (!field) return { ...structuredClone(defaults), enabled: model.enabled, catalog: { ...defaults.catalog, overrides: [] } };
  const next = { ...model, catalog: { ...defaults.catalog, overrides: model.catalog?.overrides.filter(value => value !== field) ?? MODEL_CATALOG_FIELDS.filter(value => value !== field) } };
  if (defaults[field] === undefined) delete next[field]; else Object.assign(next, { [field]: structuredClone(defaults[field]) });
  return next;
}

export function addModels(models: ChannelModel[], entries: DiscoveredModel[], type: ChannelTypeInfo): ChannelModel[] {
  const seen = new Set(models.map(model => model.id));
  const added: ChannelModel[] = [];
  for (const entry of entries) {
    const id = entry.id.trim(); if (!id || seen.has(id)) continue; seen.add(id);
    const catalog = type.catalog?.find(model => model.id === id);
    const operations = (entry.operations ?? catalog?.operations)?.filter(operation => type.operations.includes(operation));
    const compat = { ...(type.id === 'deepseek' ? { thinkingFormat: 'deepseek' } : type.id === 'openrouter' ? { thinkingFormat: 'openrouter' } : {}), ...catalog?.compat, ...entry.compat };
    added.push(applyModelDirectoryDefaults({ ...structuredClone(catalog), ...structuredClone(entry), id,
      name: entry.name && entry.name !== id ? entry.name : catalog?.name || entry.name || id, enabled: true,
      operations: operations?.length ? operations : type.operations.includes('chat') ? ['chat'] : [type.operations[0]!],
      ...(Object.keys(compat).length ? { compat } : {}),
      ...(entry.catalog || catalog ? { catalog: { ...catalog?.catalog, ...entry.catalog, overrides: [] } } : {}),
    }, catalog));
  }
  return [...models, ...added];
}
