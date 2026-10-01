import React from 'react';
import type {
  JsonValue,
  PiConfigScope,
  PiSettingsSnapshot,
  RuntimeContextTarget,
  ThinkingLevel,
} from '@varin/protocol';
import { THINKING_LEVELS } from '@varin/protocol';
import { toast } from '@/components/ui';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  SettingsSection,
  SettingsFieldRow,
  SettingsCheckboxRow,
  SettingsInset,
  SettingsGroupTitle,
  SETTINGS_CUSTOM_TRIGGER_CLASS,
  SETTINGS_SELECT_ROW_TRIGGER_CLASS,
  SETTINGS_SELECT_SIZE,
  SETTINGS_OPTION_STACK_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { SettingsInfoHint } from '@/components/sections/shared/SettingsInfoHint';
import { getRegisteredRuntimeAPIs } from '@/lib/runtime-api/registry';
import { useI18n } from '@/lib/i18n';
import { parseModelIdentifier } from '@/lib/modelIdentifier';
import { getPiSettings, updatePiSettings } from '@/lib/pi-runtime/settings';
import { updateDesktopSettings } from '@/lib/persistence';
import { runtimeFetch } from '@varin/application-client';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { usePiProviderStore } from '@/stores/usePiProviderStore';
import { useUIStore } from '@/stores/useUIStore';

const DEFAULT_VALUE = '__default__';

type ProductDefaults = {
  smallModelOverride?: string;
  smallModelUseDefault?: boolean;
  walkthroughModelOverride?: string;
};

const getDisplayModel = (
  storedModel: string | undefined,
): { providerId: string; modelId: string } => (
  parseModelIdentifier(storedModel) ?? { providerId: '', modelId: '' }
);

const readString = (value: JsonValue | undefined): string | undefined => (
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
);

const isThinkingLevel = (value: string | undefined): value is ThinkingLevel => (
  value !== undefined && (THINKING_LEVELS as readonly string[]).includes(value)
);

const loadProductDefaults = async (): Promise<ProductDefaults> => {
  const runtimeSettings = getRegisteredRuntimeAPIs()?.settings;
  if (runtimeSettings) {
    try {
      const result = await runtimeSettings.load();
      if (result?.settings) {
        const settings = result.settings as Record<string, unknown>;
        return {
          smallModelOverride: typeof settings.smallModelOverride === 'string'
            ? settings.smallModelOverride
            : undefined,
          smallModelUseDefault: typeof settings.smallModelUseDefault === 'boolean'
            ? settings.smallModelUseDefault
            : undefined,
          walkthroughModelOverride: typeof settings.walkthroughModelOverride === 'string'
            ? settings.walkthroughModelOverride
            : undefined,
        };
      }
    } catch {
      // The shared HTTP settings endpoint is available outside desktop shells.
    }
  }

  const response = await runtimeFetch('/api/config/settings', {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) return {};
  const settings = await response.json().catch(() => null) as Record<string, unknown> | null;
  return settings ? {
    smallModelOverride: typeof settings.smallModelOverride === 'string'
      ? settings.smallModelOverride
      : undefined,
    smallModelUseDefault: typeof settings.smallModelUseDefault === 'boolean'
      ? settings.smallModelUseDefault
      : undefined,
    walkthroughModelOverride: typeof settings.walkthroughModelOverride === 'string'
      ? settings.walkthroughModelOverride
      : undefined,
  } : {};
};

export const DefaultsSettings: React.FC = () => {
  const { t } = useI18n();
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const providers = usePiProviderStore((state) => state.providers);
  const showDeletionDialog = useUIStore((state) => state.showDeletionDialog);
  const setShowDeletionDialog = useUIStore((state) => state.setShowDeletionDialog);

  const runtimeTarget = React.useMemo<RuntimeContextTarget>(
    () => ({ cwd: currentDirectory }),
    [currentDirectory],
  );
  const [scope, setScope] = React.useState<PiConfigScope>('global');
  const [snapshot, setSnapshot] = React.useState<PiSettingsSnapshot | null>(null);
  const [settingsError, setSettingsError] = React.useState<string | null>(null);
  const [isLoading, setIsLoading] = React.useState(true);
  const [isSaving, setIsSaving] = React.useState(false);
  const [smallModelUseDefault, setSmallModelUseDefault] = React.useState(true);
  const [smallModelOverride, setSmallModelOverride] = React.useState<string | undefined>();
  const [walkthroughModelOverride, setWalkthroughModelOverride] = React.useState<string | undefined>();
  const [smallModelProviders, setSmallModelProviders] = React.useState<string[] | undefined>();

  React.useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setSettingsError(null);
    void Promise.allSettled([
      getPiSettings(runtimeTarget),
      loadProductDefaults(),
    ]).then(([piResult, productResult]) => {
      if (cancelled) return;
      if (piResult.status === 'fulfilled') {
        setSnapshot(piResult.value);
      } else {
        setSnapshot(null);
        setSettingsError(piResult.reason instanceof Error ? piResult.reason.message : String(piResult.reason));
      }
      if (productResult.status === 'fulfilled') {
        setSmallModelUseDefault(productResult.value.smallModelUseDefault ?? true);
        const override = productResult.value.smallModelOverride?.trim();
        setSmallModelOverride(override || undefined);
        const walkthroughOverride = productResult.value.walkthroughModelOverride?.trim();
        setWalkthroughModelOverride(walkthroughOverride || undefined);
      }
      setIsLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [runtimeTarget]);

  React.useEffect(() => {
    if (scope === 'project' && snapshot && !snapshot.projectTrusted) {
      setScope('global');
    }
  }, [scope, snapshot]);

  const globalSettings = snapshot?.global ?? {};
  const projectSettings = snapshot?.project ?? {};
  const scopedSettings = scope === 'global' ? globalSettings : projectSettings;
  const effectiveSettings = scope === 'global'
    ? globalSettings
    : { ...globalSettings, ...projectSettings };

  const scopedProviderId = readString(scopedSettings.defaultProvider);
  const scopedModelId = readString(scopedSettings.defaultModel);
  const scopedThinking = readString(scopedSettings.defaultThinkingLevel);
  const effectiveProviderId = readString(effectiveSettings.defaultProvider);
  const effectiveModelId = readString(effectiveSettings.defaultModel);
  const effectiveThinking = readString(effectiveSettings.defaultThinkingLevel);

  const effectiveModel = React.useMemo(() => (
    providers
      .find((provider) => provider.id === effectiveProviderId)
      ?.models.find((model) => model.id === effectiveModelId)
  ), [effectiveModelId, effectiveProviderId, providers]);
  const availableThinkingLevels = React.useMemo<ThinkingLevel[]>(() => {
    const supported = effectiveModel?.supportedThinkingLevels ?? [...THINKING_LEVELS];
    if (isThinkingLevel(scopedThinking) && !supported.includes(scopedThinking)) {
      return [scopedThinking, ...supported];
    }
    return supported;
  }, [effectiveModel, scopedThinking]);

  const savePiDefaults = React.useCallback(async (
    changes: { remove: string[]; set: { [key: string]: JsonValue } },
  ) => {
    if (isSaving) return;
    const expectedRevision = scope === 'global'
      ? snapshot?.globalRevision
      : snapshot?.projectRevision;
    if (!expectedRevision) return;
    setIsSaving(true);
    setSettingsError(null);
    try {
      const next = await updatePiSettings(runtimeTarget, scope, changes, expectedRevision);
      setSnapshot(next);
      toast.success(t('settings.common.status.saved'));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSettingsError(message);
      toast.error(t('settings.common.status.saveFailed'));
    } finally {
      setIsSaving(false);
    }
  }, [isSaving, runtimeTarget, scope, snapshot, t]);

  const handleModelChange = React.useCallback((providerId: string, modelId: string) => {
    if (!providerId || !modelId) {
      void savePiDefaults({ remove: ['defaultProvider', 'defaultModel'], set: {} });
      return;
    }
    void savePiDefaults({
      remove: [],
      set: { defaultProvider: providerId, defaultModel: modelId },
    });
  }, [savePiDefaults]);

  const handleThinkingChange = React.useCallback((value: string) => {
    if (value === DEFAULT_VALUE) {
      void savePiDefaults({ remove: ['defaultThinkingLevel'], set: {} });
      return;
    }
    if (isThinkingLevel(value)) {
      void savePiDefaults({ remove: [], set: { defaultThinkingLevel: value } });
    }
  }, [savePiDefaults]);

  const handleSmallModelUseDefaultChange = React.useCallback(async (useDefault: boolean) => {
    setSmallModelUseDefault(useDefault);
    try {
      await updateDesktopSettings({ smallModelUseDefault: useDefault });
    } catch (error) {
      console.warn('Failed to save small model preference:', error);
    }
  }, []);

  const handleSmallModelOverrideChange = React.useCallback(async (providerId: string, modelId: string) => {
    const newValue = providerId && modelId ? `${providerId}/${modelId}` : undefined;
    setSmallModelOverride(newValue);
    try {
      await updateDesktopSettings({ smallModelOverride: newValue ?? '' });
    } catch (error) {
      console.warn('Failed to save small model override:', error);
    }
  }, []);

  const parsedSmallModel = React.useMemo(
    () => getDisplayModel(smallModelOverride),
    [smallModelOverride],
  );
  const parsedWalkthroughModel = React.useMemo(
    () => getDisplayModel(walkthroughModelOverride),
    [walkthroughModelOverride],
  );

  const handleWalkthroughModelChange = React.useCallback(async (providerId: string, modelId: string) => {
    const newValue = providerId && modelId ? `${providerId}/${modelId}` : undefined;
    setWalkthroughModelOverride(newValue);
    try {
      await updateDesktopSettings({ walkthroughModelOverride: newValue ?? '' });
    } catch (error) {
      console.warn('Failed to save walkthrough model override:', error);
    }
  }, []);

  React.useEffect(() => {
    if (smallModelProviders !== undefined) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await runtimeFetch('/api/small-model', {
          method: 'GET',
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) return;
        const payload = await response.json().catch(() => null) as { authenticatedProviders?: unknown } | null;
        if (!cancelled && Array.isArray(payload?.authenticatedProviders)) {
          setSmallModelProviders(
            payload.authenticatedProviders.filter((id): id is string => typeof id === 'string'),
          );
        }
      } catch {
        // The picker can still show every connected Pi provider.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [smallModelProviders]);

  if (isLoading) return null;

  const defaultPlaceholder = scope === 'project'
    ? t('settings.varin.defaults.option.inheritGlobal')
    : t('settings.varin.defaults.option.piDefault');
  const summaryModel = effectiveProviderId && effectiveModelId
    ? `${effectiveProviderId}/${effectiveModelId}`
    : t('settings.varin.defaults.option.piDefault');

  return (
    <SettingsSection title={t('settings.varin.defaults.title')} divider={false}>
      <div className="space-y-0">
        <div className="mt-0 mb-1 typography-meta text-muted-foreground">
          {t('settings.varin.defaults.summaryPrefix')}{' '}
          <span className="text-foreground">
            {summaryModel}
            {effectiveThinking ? ` (${effectiveThinking})` : ''}
          </span>
        </div>

        <div>
          <SettingsFieldRow
            settingsItem="sessions.default-scope"
            label={t('settings.varin.defaults.field.scope')}
          >
            <Select value={scope} onValueChange={(value) => setScope(value as PiConfigScope)}>
              <SelectTrigger size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="global">{t('settings.common.scope.global')}</SelectItem>
                <SelectItem value="project" disabled={!snapshot?.projectTrusted}>
                  {t('settings.common.scope.project')}
                </SelectItem>
              </SelectContent>
            </Select>
          </SettingsFieldRow>

          <SettingsFieldRow
            settingsItem="sessions.default-model"
            label={t('settings.varin.defaults.field.defaultModel')}
          >
            <ModelSelector
              providerId={scopedProviderId ?? ''}
              modelId={scopedModelId ?? ''}
              onChange={handleModelChange}
              placeholder={defaultPlaceholder}
              className={SETTINGS_CUSTOM_TRIGGER_CLASS}
            />
          </SettingsFieldRow>

          <SettingsFieldRow
            settingsItem="sessions.default-thinking"
            label={t('settings.varin.defaults.field.defaultThinking')}
          >
            <Select
              value={isThinkingLevel(scopedThinking) ? scopedThinking : DEFAULT_VALUE}
              onValueChange={handleThinkingChange}
              disabled={isSaving || snapshot === null}
            >
              <SelectTrigger size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}>
                <SelectValue placeholder={t('settings.varin.defaults.field.thinkingPlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DEFAULT_VALUE}>{defaultPlaceholder}</SelectItem>
                {availableThinkingLevels.map((level) => (
                  <SelectItem key={level} value={level}>
                    {level.charAt(0).toUpperCase() + level.slice(1)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsFieldRow>
          {scope === 'global' ? <SettingsFieldRow settingsItem="pi.cache-warming"
            label={t('settings.pi.cacheWarming.title')} description={t('settings.pi.cacheWarming.description')}>
            <Select value={readString(scopedSettings.cacheWarming) ?? DEFAULT_VALUE}
              disabled={isSaving || snapshot === null}
              onValueChange={(value) => void savePiDefaults(value === DEFAULT_VALUE
                ? { remove: ['cacheWarming'], set: {} } : { remove: [], set: { cacheWarming: value } })}>
              <SelectTrigger size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={DEFAULT_VALUE}>{defaultPlaceholder}</SelectItem>
                {['off', 'streaming', 'idle'].map(value => <SelectItem key={value} value={value}>{t(`settings.pi.cacheWarming.${value}` as never)}</SelectItem>)}
              </SelectContent>
            </Select>
          </SettingsFieldRow> : null}
          <SettingsFieldRow settingsItem="pi.codemode"
            label={t('settings.pi.codemode.title')} description={t('settings.pi.codemode.description')}>
            <Select value={typeof scopedSettings.codemode === 'object' && scopedSettings.codemode !== null && !Array.isArray(scopedSettings.codemode)
              ? readString(scopedSettings.codemode.mode) ?? DEFAULT_VALUE : DEFAULT_VALUE}
              disabled={isSaving || snapshot === null}
              onValueChange={(value) => {
                const config = typeof scopedSettings.codemode === 'object' && scopedSettings.codemode !== null && !Array.isArray(scopedSettings.codemode)
                  ? { ...scopedSettings.codemode } : {};
                if (value === DEFAULT_VALUE) delete config.mode; else config.mode = value;
                void savePiDefaults(Object.keys(config).length ? { remove: [], set: { codemode: config } } : { remove: ['codemode'], set: {} });
              }}>
              <SelectTrigger size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={DEFAULT_VALUE}>{defaultPlaceholder}</SelectItem>
                <SelectItem value="on">{t('settings.pi.codemode.on')}</SelectItem>
                <SelectItem value="only">{t('settings.pi.codemode.only')}</SelectItem>
              </SelectContent>
            </Select>
          </SettingsFieldRow>
        </div>

        {settingsError ? (
          <div className="mt-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 typography-meta text-destructive">
            {settingsError}
          </div>
        ) : null}

        <SettingsInset className={SETTINGS_OPTION_STACK_CLASS}>
          <SettingsCheckboxRow
            settingsItem="sessions.deletion-dialog"
            checked={showDeletionDialog}
            onChange={setShowDeletionDialog}
            label={t('settings.varin.defaults.field.showDeletionDialog')}
            ariaLabel={t('settings.varin.defaults.field.showDeletionDialogAria')}
          />
        </SettingsInset>

        <div className="space-y-3 pt-6">
          <div className="flex items-center gap-1.5">
            <SettingsGroupTitle>
              {t('settings.varin.defaults.smallModel.title')}
            </SettingsGroupTitle>
            <SettingsInfoHint>
              {t('settings.varin.defaults.smallModel.description')}
            </SettingsInfoHint>
          </div>

          <SettingsCheckboxRow
            settingsItem="sessions.small-model"
            checked={smallModelUseDefault}
            onChange={(checked) => {
              void handleSmallModelUseDefaultChange(checked);
            }}
            label={t('settings.varin.defaults.smallModel.useDefault')}
            ariaLabel={t('settings.varin.defaults.smallModel.useDefaultAria')}
          />

          {!smallModelUseDefault ? (
            <SettingsFieldRow label={t('settings.varin.defaults.smallModel.overrideModel')}>
              <ModelSelector
                providerId={parsedSmallModel.providerId}
                modelId={parsedSmallModel.modelId}
                onChange={handleSmallModelOverrideChange}
                allowedProviderIds={smallModelProviders}
                className={SETTINGS_CUSTOM_TRIGGER_CLASS}
              />
            </SettingsFieldRow>
          ) : null}

          <SettingsInset className={SETTINGS_OPTION_STACK_CLASS}>
            <div className="flex items-center gap-1.5">
              <SettingsGroupTitle>
                {t('settings.varin.defaults.walkthroughModel.title')}
              </SettingsGroupTitle>
              <SettingsInfoHint>
                {t('settings.varin.defaults.walkthroughModel.description')}
              </SettingsInfoHint>
            </div>
            <SettingsFieldRow
              settingsItem="sessions.walkthrough-model"
              label={t('settings.varin.defaults.walkthroughModel.overrideModel')}
            >
              <ModelSelector
                providerId={parsedWalkthroughModel.providerId}
                modelId={parsedWalkthroughModel.modelId}
                onChange={handleWalkthroughModelChange}
                allowedProviderIds={smallModelProviders}
                placeholder={t('settings.varin.defaults.walkthroughModel.usesSmallModel')}
                className={SETTINGS_CUSTOM_TRIGGER_CLASS}
              />
            </SettingsFieldRow>
          </SettingsInset>
        </div>
      </div>
    </SettingsSection>
  );
};
