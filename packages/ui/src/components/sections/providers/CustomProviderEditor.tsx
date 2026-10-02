"use client";

import React from 'react';
import type { ProviderInferenceCapability } from '@varin/protocol';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import {
  discoverPiProviderModels,
  upsertPiProviderConfig,
} from '@/lib/pi-runtime/providers';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { usePiProviderStore } from '@/stores/usePiProviderStore';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  COMMON_PROVIDER_APIS,
  createEmptyCustomProviderModel,
  createEmptyCustomProviderState,
  createPiProviderConfigFromForm,
  ensureExtendedThinkingLevels,
  mergeCustomProviderModelRows,
  resolveCustomProviderApiKey,
} from './customProviderForm';
import type {
  CustomProviderEditableFormState,
  CustomProviderModelRowInput,
} from './customProviderForm';
import { CustomProviderReasoningLevels } from './CustomProviderReasoningLevels';
import { ProviderInferenceEditor } from './ProviderInferenceEditor';
import { ProviderAuthPromptView, usePiProviderAuth } from './ProviderAuthPanel';

interface CustomProviderEditorProps {
  mode: 'create' | 'edit';
  initialState?: CustomProviderEditableFormState;
  onSaved?: (providerId: string) => void;
  onCancel?: () => void;
}

const SCOPES: Array<'user' | 'project' | 'custom'> = ['user', 'project', 'custom'];

const MODEL_IMPORT_SORT_OPTIONS = [
  { value: 'id-asc', labelKey: 'settings.providers.page.modelImport.sort.idAsc' },
  { value: 'id-desc', labelKey: 'settings.providers.page.modelImport.sort.idDesc' },
  { value: 'fetched-order', labelKey: 'settings.providers.page.modelImport.sort.fetchedOrder' },
] as const;
type ModelImportSortValue = typeof MODEL_IMPORT_SORT_OPTIONS[number]['value'];
type ModelImportTarget = 'chat' | ProviderInferenceCapability;

const shouldIgnoreCapabilityCardClick = (target: EventTarget | null): boolean => (
  target instanceof HTMLElement && Boolean(target.closest('[data-capability-control="true"]'))
);

export const CustomProviderEditor: React.FC<CustomProviderEditorProps> = ({
  mode,
  initialState,
  onSaved,
  onCancel,
}) => {
  const { t } = useI18n();
  const currentDirectory = useDirectoryStore((store) => store.currentDirectory);
  const tUnsafe = React.useCallback(
    (key: string) => t(key as Parameters<typeof t>[0]),
    [t]
  );
  const [state, setState] = React.useState<CustomProviderEditableFormState>(() =>
    initialState ? { ...initialState, models: initialState.models.map((m) => ({ ...m })) } : createEmptyCustomProviderState()
  );
  const [manualApi, setManualApi] = React.useState(() => !COMMON_PROVIDER_APIS.some(api => api === state.api));
  const [saving, setSaving] = React.useState(false);
  const [fetchingModels, setFetchingModels] = React.useState<ModelImportTarget | null>(null);
  const [modelImportTarget, setModelImportTarget] = React.useState<ModelImportTarget>('chat');
  const discoveryController = React.useRef<AbortController | null>(null);
  const [modelImportDialogOpen, setModelImportDialogOpen] = React.useState(false);
  const [fetchedModels, setFetchedModels] = React.useState<CustomProviderModelRowInput[]>([]);
  const [modelImportSearch, setModelImportSearch] = React.useState('');
  const [modelImportSort, setModelImportSort] = React.useState<ModelImportSortValue>('id-asc');
  const [modelImportSelectedIds, setModelImportSelectedIds] = React.useState<Set<string>>(new Set());
  const apiKeyFieldRef = React.useRef<HTMLDivElement | null>(null);
  const originalEditScopeRef = React.useRef<CustomProviderEditableFormState['scope'] | null>(
    mode === 'edit' && initialState ? initialState.scope : null,
  );
  const mountedRef = React.useRef(false);
  const providerId = state.id.trim();
  const target = React.useMemo(() => ({ cwd: currentDirectory, providerId, scope: state.scope }), [currentDirectory, providerId, state.scope]);
  const targetRef = React.useRef(target);
  targetRef.current = target;
  const providerAuth = usePiProviderAuth({
    cwd: currentDirectory,
    providerId: state.id.trim(),
  });

  React.useEffect(() => { setSaving(false); }, [target]);

  const discoveryConnection = JSON.stringify([
    state.api, state.apiKey, state.baseURL,
    Object.values(state.inference).map(({ baseURL, credentialRef, enabled }) => [baseURL, credentialRef, enabled]),
  ]);
  React.useEffect(() => {
    setFetchingModels(null);
    setModelImportDialogOpen(false);
    return () => { discoveryController.current?.abort(); };
  }, [target, discoveryConnection, initialState]);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  React.useEffect(() => {
    if (initialState) {
      if (mode === 'edit') {
        originalEditScopeRef.current = initialState.scope;
      }
      setState({
        ...initialState,
        models: initialState.models.map((m) => ({ ...m })),
      });
      setManualApi(!COMMON_PROVIDER_APIS.some(api => api === initialState.api));
    }
  }, [initialState, mode]);

  const readApiKey = React.useCallback(() => (
    resolveCustomProviderApiKey(
      state.apiKey,
      apiKeyFieldRef.current?.querySelector<HTMLInputElement>('input[type="password"]') ?? undefined,
    )
  ), [state.apiKey]);

  const updateField = <K extends keyof CustomProviderEditableFormState>(
    field: K,
    value: CustomProviderEditableFormState[K]
  ) => {
    setState((prev) => ({ ...prev, [field]: value }));
  };

  const updateModel = <K extends keyof CustomProviderEditableFormState['models'][number]>(
    index: number,
    field: K,
    value: CustomProviderEditableFormState['models'][number][K]
  ) => {
    setState((prev) => {
      const nextModels = prev.models.map((row, i) => (i === index ? { ...row, [field]: value } : row));
      return { ...prev, models: nextModels, modelsDefined: true };
    });
  };

  const updateModelFields = (
    index: number,
    fields: Partial<CustomProviderEditableFormState['models'][number]>,
  ) => {
    setState((prev) => ({
      ...prev,
      models: prev.models.map((row, rowIndex) => (rowIndex === index ? { ...row, ...fields } : row)),
      modelsDefined: true,
    }));
  };

  const addModel = () => {
    setState((prev) => ({
      ...prev,
      models: [
        ...prev.models,
        createEmptyCustomProviderModel(),
      ],
      modelsDefined: true,
    }));
  };

  const removeModel = (index: number) => {
    setState((prev) => {
      const nextModels = prev.models.filter((_, i) => i !== index);
      return {
        ...prev,
        models: nextModels.length > 0 ? nextModels : [createEmptyCustomProviderModel()],
        modelsDefined: true,
      };
    });
  };

  const handleFetchModels = async (kind: ModelImportTarget) => {
    const providerId = state.id.trim();
    const capability = kind === 'chat' ? undefined : state.inference[kind];
    const credentialRef = capability?.credentialRef.trim();
    const apiKey = !credentialRef || credentialRef === providerId ? readApiKey() : '';

    if (!providerId) {
      toast.error(t('settings.providers.page.toast.customProviderRequired'));
      return;
    }

    discoveryController.current?.abort();
    const controller = new AbortController();
    discoveryController.current = controller;
    setFetchingModels(kind);
    try {
      const discovery = await discoverPiProviderModels(currentDirectory, providerId, {
        ...(kind === 'chat' ? {} : { capability: kind }),
        ...(apiKey ? { apiKey } : {}),
        config: createPiProviderConfigFromForm(state),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      const fetched = discovery.models;
      if (fetched.length === 0) {
        toast.error(t('settings.providers.page.toast.customProviderFetchNoModels'));
        return;
      }

      setFetchedModels(fetched);
      setModelImportTarget(kind);
      setModelImportSearch('');
      setModelImportSort('id-asc');
      setModelImportSelectedIds(() => {
        const next = new Set<string>();
        // Inference endpoints often list every model. Let the user choose the
        // relevant models instead of guessing capabilities from their names.
        if (kind !== 'chat') return next;
        const existingIds = new Set(state.models.map(model => model.id.trim()));
        for (const model of fetched) {
          const id = String(model.id ?? '').trim();
          if (id && !existingIds.has(id)) {
            next.add(id);
          }
        }
        return next;
      });
      setModelImportDialogOpen(true);
    } catch (error) {
      if (!controller.signal.aborted) toast.error(t('settings.providers.page.toast.customProviderFetchFailed'), {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      if (discoveryController.current === controller) {
        discoveryController.current = null;
        if (mountedRef.current) setFetchingModels(null);
      }
    }
  };

  const existingModelIds = React.useMemo(() => {
    const ids = new Set<string>();
    for (const row of modelImportTarget === 'chat' ? state.models : state.inference[modelImportTarget].models) {
      const id = row.id.trim();
      if (id) {
        ids.add(id);
      }
    }
    return ids;
  }, [state.models, state.inference, modelImportTarget]);

  const modelImportSummary = React.useMemo(() => {
    const total = fetchedModels.length;
    let newCount = 0;
    for (const model of fetchedModels) {
      const id = String(model.id ?? '').trim();
      if (id && !existingModelIds.has(id)) {
        newCount += 1;
      }
    }
    return {
      total,
      newCount,
      existingCount: total - newCount,
    };
  }, [fetchedModels, existingModelIds]);

  const displayFetchedModels = React.useMemo(() => {
    const query = modelImportSearch.trim().toLowerCase();
    let rows = fetchedModels.map((model, index) => ({ model, index }));

    if (query) {
      rows = rows.filter(({ model }) => {
        const id = String(model.id ?? '').trim().toLowerCase();
        const name = String(model.name ?? '').trim().toLowerCase();
        return id.includes(query) || name.includes(query);
      });
    }

    switch (modelImportSort) {
      case 'id-asc':
        rows.sort((a, b) => {
          const idA = String(a.model.id ?? '').trim().toLowerCase();
          const idB = String(b.model.id ?? '').trim().toLowerCase();
          return idA.localeCompare(idB);
        });
        break;
      case 'id-desc':
        rows.sort((a, b) => {
          const idA = String(a.model.id ?? '').trim().toLowerCase();
          const idB = String(b.model.id ?? '').trim().toLowerCase();
          return idB.localeCompare(idA);
        });
        break;
      default:
        break;
    }

    return rows;
  }, [fetchedModels, modelImportSearch, modelImportSort]);

  const toggleModelImportSelection = (id: string) => {
    setModelImportSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const selectAllVisibleFetchedModels = () => {
    setModelImportSelectedIds((prev) => {
      const next = new Set(prev);
      for (const { model } of displayFetchedModels) {
        const id = String(model.id ?? '').trim();
        if (id) {
          next.add(id);
        }
      }
      return next;
    });
  };

  const clearVisibleFetchedModels = () => {
    setModelImportSelectedIds((prev) => {
      const next = new Set(prev);
      for (const { model } of displayFetchedModels) {
        const id = String(model.id ?? '').trim();
        if (id) {
          next.delete(id);
        }
      }
      return next;
    });
  };

  const selectNewVisibleFetchedModels = () => {
    setModelImportSelectedIds((prev) => {
      const next = new Set(prev);
      for (const { model } of displayFetchedModels) {
        const id = String(model.id ?? '').trim();
        if (id && !existingModelIds.has(id)) {
          next.add(id);
        }
      }
      return next;
    });
  };

  const applyModelImport = () => {
    const selectedModels = fetchedModels.filter((model) => {
      const id = String(model.id ?? '').trim();
      return id && modelImportSelectedIds.has(id);
    });

    if (selectedModels.length === 0) {
      setModelImportDialogOpen(false);
      return;
    }

    setState((prev) => ({
      ...prev,
      ...(modelImportTarget === 'chat' ? {
        models: mergeCustomProviderModelRows(prev.models, selectedModels),
        modelsDefined: true,
      } : {
        inference: {
          ...prev.inference,
          [modelImportTarget]: {
            ...prev.inference[modelImportTarget],
            models: mergeCustomProviderModelRows(prev.inference[modelImportTarget].models, selectedModels),
          },
        },
      }),
    }));

    toast.success(
      t('settings.providers.page.toast.customProviderModelsImported', { count: selectedModels.length }),
    );
    setModelImportDialogOpen(false);
    setFetchedModels([]);
    setModelImportSelectedIds(new Set());
  };

  const renderModelImportSortLabel = (value: ModelImportSortValue) => {
    const option = MODEL_IMPORT_SORT_OPTIONS.find((opt) => opt.value === value);
    return option ? tUnsafe(option.labelKey) : '';
  };

  const validate = (): boolean => {
    const id = state.id.trim();
    if (!id) {
      toast.error(t('settings.providers.page.toast.customProviderRequired'));
      return false;
    }

    const invalidNumber = state.models.some((row) => [row.context, row.output].some((value) => {
      const normalized = value.trim().replace(/,/g, '');
      return normalized.length > 0 && (!Number.isFinite(Number(normalized)) || Number(normalized) <= 0);
    }));
    if (invalidNumber) {
      toast.error(t('settings.providers.page.toast.customProviderModelLimitsInvalid'));
      return false;
    }

    return true;
  };

  const handleSave = async () => {
    if (!validate()) {
      return;
    }

    const saveTarget = targetRef.current;
    const isCurrentTarget = () => (
      mountedRef.current && targetRef.current === saveTarget
    );
    setSaving(true);
    try {
      const resolvedScope = mode === 'edit' ? (originalEditScopeRef.current ?? state.scope) : state.scope;
      const apiKey = readApiKey();
      const config = createPiProviderConfigFromForm(state);
      await upsertPiProviderConfig(currentDirectory, resolvedScope, config);
      if (!isCurrentTarget()) return;
      if (apiKey) {
        const authResult = await providerAuth.start('api_key', { seedSecret: apiKey });
        if (authResult.status === 'cancelled') {
          if (!isCurrentTarget()) return;
          await usePiProviderStore.getState().load(saveTarget.cwd, { force: true });
          if (!isCurrentTarget()) return;
          toast.info(t('settings.providers.page.toast.customProviderSavedAuthCancelled'));
          onSaved?.(config.id);
          return;
        }
        if (authResult.status === 'failed') {
          if (!isCurrentTarget()) return;
          throw authResult.error instanceof Error ? authResult.error : new Error(t('settings.providers.page.toast.customProviderSaveFailed'));
        }
      }

      if (!isCurrentTarget()) return;
      await usePiProviderStore.getState().load(saveTarget.cwd, { force: true });
      if (!isCurrentTarget()) return;
      toast.success(t('settings.providers.page.toast.customProviderSaved'));
      onSaved?.(config.id);
    } catch (error) {
      console.error('Failed to save custom provider:', error);
      if (!isCurrentTarget()) return;
      const message = error instanceof Error ? error.message : t('settings.providers.page.toast.customProviderSaveFailed');
      toast.error(message);
    } finally {
      if (isCurrentTarget()) setSaving(false);
    }
  };

  const renderTypeLabel = (api: string) => {
    switch (api) {
      case 'openai-completions':
        return t('settings.providers.page.custom.type.openaiCompatible.label');
      case 'openai-responses':
        return t('settings.providers.page.custom.type.openaiResponses.label');
      case 'anthropic-messages':
        return t('settings.providers.page.custom.type.anthropic.label');
      case 'google-generative-ai':
        return t('settings.providers.page.custom.type.google.label');
      default:
        return api;
    }
  };

  const renderTypeDescription = (api: string) => {
    switch (api) {
      case 'openai-completions':
        return t('settings.providers.page.custom.type.openaiCompatible.description');
      case 'openai-responses':
        return t('settings.providers.page.custom.type.openaiResponses.description');
      case 'anthropic-messages':
        return t('settings.providers.page.custom.type.anthropic.description');
      case 'google-generative-ai':
        return t('settings.providers.page.custom.type.google.description');
      default:
        return '';
    }
  };

  return (
    <div className="space-y-6">
      <div data-settings-item="providers.custom" className="space-y-4">
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <label className="typography-ui-label text-foreground">
                {t('settings.providers.page.custom.field.id')}
              </label>
              <Input
                value={state.id}
                onChange={(event) => updateField('id', event.target.value)}
                placeholder={t('settings.providers.page.custom.placeholder.id')}
                className="h-7"
                disabled={mode === 'edit'}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="typography-ui-label text-foreground">
                {t('settings.providers.page.custom.field.name')}
              </label>
              <Input
                value={state.name}
                onChange={(event) => updateField('name', event.target.value)}
                placeholder={t('settings.providers.page.custom.placeholder.name')}
                className="h-7"
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="typography-ui-label text-foreground">
              {t('settings.providers.page.custom.field.baseURL')}
            </label>
            <Input
              value={state.baseURL}
              onChange={(event) => updateField('baseURL', event.target.value)}
              placeholder={t('settings.providers.page.custom.placeholder.baseURL')}
              className="h-7"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="typography-ui-label text-foreground">
              {t('settings.providers.page.custom.field.scope')}
            </label>
            {mode === 'edit' ? (
              <div className="flex h-7 w-fit items-center rounded-lg border border-[var(--interactive-border)] px-2 typography-ui-label text-muted-foreground">
                {tUnsafe(`settings.providers.page.custom.scope.${originalEditScopeRef.current ?? state.scope}`)}
              </div>
            ) : (
              <Select
                value={state.scope}
                onValueChange={(value) => updateField('scope', value as 'user' | 'project' | 'custom')}
              >
                <SelectTrigger className="w-full sm:w-[200px]">
                  <SelectValue>
                    {(value) => (value ? tUnsafe(`settings.providers.page.custom.scope.${value}`) : '')}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {SCOPES.map((scope) => (
                    <SelectItem key={scope} value={scope}>
                      {tUnsafe(`settings.providers.page.custom.scope.${scope}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <div ref={apiKeyFieldRef} className="flex flex-col gap-1.5">
            <label className="typography-ui-label text-foreground">
              {t('settings.providers.page.custom.field.apiKey')}
            </label>
            <Input
              type="password"
              value={state.apiKey}
              onChange={(event) => updateField('apiKey', event.target.value)}
              placeholder={t('settings.providers.page.custom.placeholder.apiKey')}
              className="h-7 font-mono text-xs"
            />
            <label className="flex cursor-pointer items-center gap-2">
              <Checkbox
                checked={state.authHeader === true}
                onChange={(checked) => updateField('authHeader', checked)}
                ariaLabel="Authorization header"
              />
              <span className="typography-meta text-muted-foreground">Authorization: Bearer</span>
            </label>
          </div>
        </div>

        <label className="flex items-center gap-2 typography-ui-label">
          <Checkbox checked={state.chatEnabled} onChange={chatEnabled => setState(prev => ({ ...prev, chatEnabled, chatDefined: true }))}
            ariaLabel={t('settings.providers.page.custom.capability.chat')} />
          {t('settings.providers.page.custom.capability.chat')}
        </label>
        {state.chatEnabled && <div className="space-y-3 rounded-lg border border-[var(--surface-subtle)] p-3">
          <div className="flex flex-col gap-1.5">
            <label className="typography-ui-label text-foreground">{t('settings.providers.page.custom.field.type')}</label>
            <Select value={manualApi ? 'custom' : state.api} onValueChange={value => {
              setManualApi(value === 'custom');
              if (value !== 'custom') updateField('api', value);
            }}>
              <SelectTrigger className="w-full sm:w-[280px]" aria-label={t('settings.providers.page.custom.field.type')}>
                <SelectValue>{manualApi ? t('settings.providers.page.custom.type.other.label') : renderTypeLabel(state.api)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {COMMON_PROVIDER_APIS.map(api => <SelectItem key={api} value={api}>{renderTypeLabel(api)}</SelectItem>)}
                <SelectItem value="custom">{t('settings.providers.page.custom.type.other.label')}</SelectItem>
              </SelectContent>
            </Select>
            {manualApi && <Input value={state.api} onChange={event => updateField('api', event.target.value)}
              aria-label={t('settings.providers.page.custom.type.other.label')} placeholder="my-extension-api" className="h-7 w-full font-mono sm:w-[280px]" />}
            <span className="typography-micro text-muted-foreground">
              {manualApi ? t('settings.providers.page.custom.type.other.description') : renderTypeDescription(state.api)}
            </span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <h3 className="typography-ui-header font-medium text-foreground">
              {t('settings.providers.page.custom.field.models')}
            </h3>
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="xs"
                className="!font-normal"
                onClick={() => handleFetchModels('chat')}
                disabled={fetchingModels !== null}
              >
                {fetchingModels === 'chat'
                  ? t('settings.providers.page.actions.fetchingModels')
                  : t('settings.providers.page.actions.fetchModels')}
              </Button>
              <Button variant="outline" size="xs" className="!font-normal" onClick={addModel}>
                {t('settings.providers.page.actions.addModel')}
              </Button>
            </div>
          </div>

          <div className="space-y-3">
            {state.models.map((row, index) => (
              <div
                key={index}
                className="rounded-lg border border-[var(--surface-subtle)] p-3"
              >
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  <div className="flex flex-col gap-1.5">
                    <label className="typography-meta text-muted-foreground">
                      {t('settings.providers.page.custom.field.models')}
                    </label>
                    <Input
                      value={row.id}
                      onChange={(event) => updateModel(index, 'id', event.target.value)}
                      placeholder={t('settings.providers.page.custom.placeholder.modelId')}
                      className="h-7"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label className="typography-meta text-muted-foreground">
                      {t('settings.providers.page.custom.field.name')}
                    </label>
                    <Input
                      value={row.name}
                      onChange={(event) => updateModel(index, 'name', event.target.value)}
                      placeholder={t('settings.providers.page.custom.placeholder.modelName')}
                      className="h-7"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label className="typography-meta text-muted-foreground">
                      {t('settings.providers.page.models.tokenBadge.context')}
                    </label>
                    <Input
                      value={row.context}
                      onChange={(event) => updateModel(index, 'context', event.target.value)}
                      placeholder={t('settings.providers.page.custom.placeholder.contextLimit')}
                      className="h-7"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label className="typography-meta text-muted-foreground">
                      {t('settings.providers.page.models.tokenBadge.output')}
                    </label>
                    <Input
                      value={row.output}
                      onChange={(event) => updateModel(index, 'output', event.target.value)}
                      placeholder={t('settings.providers.page.custom.placeholder.outputLimit')}
                      className="h-7"
                    />
                  </div>
                </div>

                <div className="mt-3 space-y-2">
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <div
                      className="flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-lg border border-[var(--surface-subtle)] px-3 py-2 transition-colors hover:bg-interactive-hover"
                      onClick={(event) => {
                        if (shouldIgnoreCapabilityCardClick(event.target)) return;
                        updateModel(index, 'attachment', !row.attachment);
                      }}
                    >
                      <span className="typography-ui-label font-normal text-foreground">
                        {t('settings.providers.page.models.capability.imageInput')}
                      </span>
                      <span data-capability-control="true" className="flex shrink-0">
                        <Switch
                          checked={row.attachment}
                          onCheckedChange={(checked) => updateModel(index, 'attachment', checked)}
                          aria-label={t('settings.providers.page.models.capability.imageInput')}
                        />
                      </span>
                    </div>

                    <div
                      className="flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-lg border border-[var(--surface-subtle)] px-3 py-2 transition-colors hover:bg-interactive-hover"
                      onClick={(event) => {
                        if (shouldIgnoreCapabilityCardClick(event.target)) return;
                        const reasoning = !row.reasoning;
                        updateModelFields(index, {
                          reasoning,
                          ...(reasoning
                            ? { thinkingLevelMap: ensureExtendedThinkingLevels(row.thinkingLevelMap) }
                            : {}),
                        });
                      }}
                    >
                      <span className="typography-ui-label font-normal text-foreground">
                        {t('settings.providers.page.models.capability.reasoning')}
                      </span>
                      <span data-capability-control="true" className="flex shrink-0">
                        <Switch
                          checked={row.reasoning}
                          onCheckedChange={(reasoning) => updateModelFields(index, {
                            reasoning,
                            ...(reasoning
                              ? { thinkingLevelMap: ensureExtendedThinkingLevels(row.thinkingLevelMap) }
                              : {}),
                          })}
                          aria-label={t('settings.providers.page.models.capability.reasoning')}
                        />
                      </span>
                    </div>
                  </div>

                  <div
                    aria-hidden={!row.reasoning}
                    className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out ${
                      row.reasoning
                        ? 'grid-rows-[1fr] opacity-100'
                        : 'pointer-events-none grid-rows-[0fr] opacity-0'
                    }`}
                  >
                    <div className="min-h-0 overflow-hidden">
                      <CustomProviderReasoningLevels
                        value={row.thinkingLevelMap}
                        onChange={(thinkingLevelMap) => updateModel(index, 'thinkingLevelMap', thinkingLevelMap)}
                      />
                    </div>
                  </div>
                </div>

                <div className="mt-3 flex justify-end">
                  <Button
                    variant="ghost"
                    size="xs"
                    className="!font-normal text-[var(--status-error)] hover:text-[var(--status-error)]"
                    onClick={() => removeModel(index)}
                  >
                    {t('settings.providers.page.actions.removeModel')}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>}
        {state.scope === 'project' && <p className="typography-meta text-muted-foreground">{t('settings.providers.page.custom.capability.projectScope')}</p>}
        <ProviderInferenceEditor value={state.inference} onFetchModels={handleFetchModels} fetchingModels={fetchingModels} onChange={(kind, patch) => setState(prev => ({
          ...prev, inference: { ...prev.inference, [kind]: { ...prev.inference[kind], ...patch } },
        }))} />
      </div>

      {providerAuth.busy && (
        <div className="space-y-2 rounded-lg border border-[var(--surface-subtle)] p-3">
          <p className="typography-ui-label text-foreground">{t('settings.providers.page.auth.title')}</p>
          <ProviderAuthPromptView auth={providerAuth} />
        </div>
      )}

      <div className="flex items-center justify-end gap-2">
        {onCancel && (
          <Button variant="outline" size="xs" className="!font-normal" onClick={onCancel} disabled={saving}>
            {t('settings.providers.page.actions.cancel')}
          </Button>
        )}
        <Button size="xs" className="!font-normal" onClick={handleSave} disabled={saving}>
          {saving ? t('settings.providers.page.actions.saving') : t('settings.providers.page.actions.saveProvider')}
        </Button>
      </div>

      <Dialog open={modelImportDialogOpen} onOpenChange={setModelImportDialogOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{t('settings.providers.page.modelImport.title')} · {t(`settings.providers.page.custom.capability.${modelImportTarget}`)}</DialogTitle>
            <DialogDescription>
              {t('settings.providers.page.modelImport.description')}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <span className="typography-small text-muted-foreground">
                {t('settings.providers.page.modelImport.summary', {
                  total: modelImportSummary.total,
                  newCount: modelImportSummary.newCount,
                  existingCount: modelImportSummary.existingCount,
                })}
              </span>
              <div className="flex items-center gap-2">
                <Select value={modelImportSort} onValueChange={(value) => setModelImportSort(value as ModelImportSortValue)}>
                  <SelectTrigger className="h-7 w-[160px]">
                    <SelectValue>{renderModelImportSortLabel(modelImportSort)}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {MODEL_IMPORT_SORT_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {tUnsafe(option.labelKey)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <Input
              value={modelImportSearch}
              onChange={(event) => setModelImportSearch(event.target.value)}
              placeholder={t('settings.providers.page.modelImport.field.searchPlaceholder')}
              aria-label={t('settings.providers.page.modelImport.field.searchAria')}
              className="h-7"
            />

            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="xs"
                className="!font-normal"
                onClick={selectAllVisibleFetchedModels}
              >
                {t('settings.providers.page.modelImport.actions.selectAll')}
              </Button>
              <Button
                variant="outline"
                size="xs"
                className="!font-normal"
                onClick={selectNewVisibleFetchedModels}
              >
                {t('settings.providers.page.modelImport.actions.selectNew')}
              </Button>
              <Button
                variant="outline"
                size="xs"
                className="!font-normal"
                onClick={clearVisibleFetchedModels}
              >
                {t('settings.providers.page.modelImport.actions.clear')}
              </Button>
            </div>

            <div className="max-h-[320px] overflow-y-auto rounded-lg border border-[var(--surface-subtle)] p-1">
              {displayFetchedModels.length === 0 ? (
                <div className="px-3 py-4 text-center typography-ui-label text-muted-foreground">
                  {t('settings.providers.page.modelImport.empty.noMatches')}
                </div>
              ) : (
                <div className="space-y-0.5">
                  {displayFetchedModels.map(({ model, index }) => {
                    const id = String(model.id ?? '').trim();
                    const name = String(model.name ?? '').trim();
                    const isExisting = existingModelIds.has(id);
                    const isSelected = id ? modelImportSelectedIds.has(id) : false;

                    return (
                      <div
                        key={`${index}-${id}`}
                        role="button"
                        tabIndex={0}
                        className="group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-[var(--interactive-hover)]"
                        onClick={() => id && toggleModelImportSelection(id)}
                        onKeyDown={(event) => {
                          if ((event.key === 'Enter' || event.key === ' ') && id) {
                            event.preventDefault();
                            toggleModelImportSelection(id);
                          }
                        }}
                      >
                        <span data-checkbox-control="true" onClick={(event) => event.stopPropagation()}>
                          <Checkbox
                            checked={isSelected}
                            onChange={() => id && toggleModelImportSelection(id)}
                            ariaLabel={id}
                          />
                        </span>
                        <div className="flex min-w-0 flex-1 items-center gap-2">
                          <span className="typography-ui-label truncate">{id}</span>
                          {name && name !== id && (
                            <span className="typography-small text-muted-foreground truncate">{name}</span>
                          )}
                        </div>
                        {isExisting ? (
                          <span className="typography-micro rounded bg-[var(--surface-subtle)] px-1.5 py-0.5 text-muted-foreground">
                            {t('settings.providers.page.modelImport.badge.existing')}
                          </span>
                        ) : (
                          <span className="typography-micro rounded bg-[var(--surface-subtle)] px-1.5 py-0.5 text-muted-foreground">
                            {t('settings.providers.page.modelImport.badge.new')}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              size="xs"
              className="!font-normal"
              onClick={() => setModelImportDialogOpen(false)}
            >
              {t('settings.providers.page.actions.cancel')}
            </Button>
            <Button
              size="xs"
              className="!font-normal"
              onClick={applyModelImport}
              disabled={modelImportSelectedIds.size === 0}
            >
              {t('settings.providers.page.modelImport.actions.apply', { count: modelImportSelectedIds.size })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
