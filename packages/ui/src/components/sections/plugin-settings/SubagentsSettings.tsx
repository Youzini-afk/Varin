import React from 'react';
import type { JsonValue, PiConfigScope, RuntimeContextTarget } from '@varin/protocol';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import {
  SettingsChipGroup,
  SettingsControlGroup,
  SettingsFieldRow,
} from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import {
  PluginBooleanField,
  PluginNumberField,
  PluginOptionalBooleanField,
  PluginOptionalNumberField,
  PluginOptionalSelectField,
  PluginSelectField,
  PluginStringField,
  PluginStringListField,
} from './PluginConfigFields';
import { PluginAdvancedDraftEditor } from './PluginAdvancedDraftEditor';
import {
  PluginConfigSource,
  PluginDraftFooter,
  PluginRuntimeNote,
  ScopeSelector,
} from './PluginSettingsPanelShared';
import {
  hasJsonPath,
  readJsonPath,
  setJsonPath,
  type JsonObject,
} from './plugin-config-model';
import { SubagentsAgentOverrides } from './SubagentsAgentOverrides';
import {
  subagentsRuntimeDraftIssue,
  subagentsSettingsDraftIssue,
  type SubagentsDraftIssue,
} from './subagents-config-model';
import {
  useConfigDocumentObjectDraft,
  useSettingsObjectDraft,
} from './usePluginConfigDraft';

interface SubagentsSettingsProps {
  runtimeTarget: RuntimeContextTarget;
  targetKey: string;
}

type SubagentsPanel = 'catalog' | 'delegation' | 'review' | 'limits';

interface FieldBindings {
  disabled: boolean;
  draft: JsonObject;
  onRemove: (path: readonly string[]) => void;
  onSet: (path: readonly string[], value: JsonValue) => void;
}

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const SUBGROUP_CLASS = 'border-t border-border/60 pt-5';

const splitModel = (value: string): { modelId: string; providerId: string } => {
  const separator = value.indexOf('/');
  return separator > 0
    ? { providerId: value.slice(0, separator), modelId: value.slice(separator + 1) }
    : { providerId: '', modelId: value };
};

const PluginModelField: React.FC<FieldBindings & {
  label: string;
  path: readonly string[];
  placeholder: string;
}> = ({ disabled, draft, label, onRemove, onSet, path, placeholder }) => {
  const { t } = useI18n();
  const raw = readJsonPath(draft, path);
  const value = typeof raw === 'string' ? raw : '';
  const parsed = splitModel(value);
  const explicit = hasJsonPath(draft, path);
  return (
    <SettingsFieldRow label={label} controlClassName="w-full max-w-[24rem]">
      <div
        aria-disabled={disabled}
        className={disabled ? 'pointer-events-none opacity-60' : undefined}
        inert={disabled ? true : undefined}
      >
        <ModelSelector
          providerId={parsed.providerId}
          modelId={parsed.modelId}
          placeholder={placeholder}
          onChange={(providerId, modelId) => {
            if (!providerId || !modelId) onRemove(path);
            else onSet(path, `${providerId}/${modelId}`);
          }}
          className="w-full max-w-72 justify-between"
          dropdownPortalToBody
        />
      </div>
      {explicit ? (
        <Button type="button" variant="ghost" size="xs" disabled={disabled} onClick={() => onRemove(path)} className="!font-normal text-muted-foreground">
          {t('settings.varin.pluginSettings.field.useDefault')}
        </Button>
      ) : (
        <span className="typography-micro text-muted-foreground">{t('settings.varin.pluginSettings.field.pluginDefault')}</span>
      )}
    </SettingsFieldRow>
  );
};

export const SubagentsSettings: React.FC<SubagentsSettingsProps> = ({ runtimeTarget, targetKey }) => {
  const { t } = useI18n();
  const tx = React.useCallback((key: string) => t(key as Parameters<typeof t>[0]), [t]);
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const [scope, setScope] = React.useState<PiConfigScope>('global');
  const [panel, setPanel] = React.useState<SubagentsPanel>('catalog');

  // Both scope controllers remain mounted so changing scope never discards either draft.
  const globalSettings = useSettingsObjectDraft({
    property: 'subagents',
    runtimeTarget,
    scope: 'global',
    targetKey: `${targetKey}:subagents-settings:global`,
  });
  const projectSettings = useSettingsObjectDraft({
    property: 'subagents',
    runtimeTarget,
    scope: 'project',
    targetKey: `${targetKey}:subagents-settings:project`,
  });
  const settings = scope === 'project' ? projectSettings : globalSettings;
  const runtime = useConfigDocumentObjectDraft({
    path: 'extensions/subagent/config.json',
    runtimeTarget,
    scope: 'global',
    targetKey: `${targetKey}:subagents-runtime:global`,
  });

  const settingsTrustBlocked = scope === 'project' && !settings.projectTrusted;
  const settingsIssue = React.useMemo(() => subagentsSettingsDraftIssue(settings.draft), [settings.draft]);
  const runtimeIssue = React.useMemo(() => subagentsRuntimeDraftIssue(runtime.draft), [runtime.draft]);
  const issueFieldLabel = React.useCallback((field: string): string => {
    const directLabels: Record<string, string> = {
      'agentOverrides': t('settings.varin.pluginSettings.subagents.overrides.validationCollection'),
      'defaultProvider': t('settings.varin.pluginSettings.subagents.field.defaultProvider'),
      'maxThinking': t('settings.varin.pluginSettings.subagents.field.maxThinking'),
      'modelScope': t('settings.varin.pluginSettings.subagents.delegation.modelAccess'),
      'modelScope.allow': t('settings.varin.pluginSettings.subagents.field.allowedModels'),
      'toolBudget': t('settings.varin.pluginSettings.subagents.field.toolBudget'),
      'toolBudget.hard': t('settings.varin.pluginSettings.subagents.field.toolHardLimit'),
      'toolBudget.soft': t('settings.varin.pluginSettings.subagents.field.toolSoftLimit'),
      'toolBudget.block': t('settings.varin.pluginSettings.subagents.field.toolsAfterBudget'),
      'turnBudget.maxTurns': t('settings.varin.pluginSettings.subagents.field.turnLimit'),
      'turnBudget.graceTurns': t('settings.varin.pluginSettings.subagents.field.turnGrace'),
      'usageBudget.tokens': t('settings.varin.pluginSettings.subagents.field.tokenHardLimit'),
      'usageBudget.tokens.hard': t('settings.varin.pluginSettings.subagents.field.tokenHardLimit'),
      'usageBudget.tokens.soft': t('settings.varin.pluginSettings.subagents.field.tokenSoftLimit'),
      'usageBudget.costUsd': t('settings.varin.pluginSettings.subagents.field.costHardLimit'),
      'usageBudget.costUsd.hard': t('settings.varin.pluginSettings.subagents.field.costHardLimit'),
      'usageBudget.costUsd.soft': t('settings.varin.pluginSettings.subagents.field.costSoftLimit'),
      'usageBudget.tokens / usageBudget.costUsd': t('settings.varin.pluginSettings.subagents.limits.hardBudgets'),
    };
    const direct = directLabels[field];
    if (direct) return direct;
    if (field.startsWith('modelScope.agents.')) {
      return t('settings.varin.pluginSettings.subagents.delegation.modelAccess');
    }
    const overrideMatch = /^agentOverrides\.([^.]+)(?:\.(.+))?$/.exec(field);
    if (!overrideMatch) return t('settings.varin.pluginSettings.subagents.overrides.validationCollection');
    const agent = overrideMatch[1] ?? '';
    const overrideField = overrideMatch[2] ?? '';
    const overrideLabels: Record<string, string> = {
      acceptanceRole: t('settings.varin.pluginSettings.subagents.field.acceptanceRole'),
      completionGuard: t('settings.varin.pluginSettings.subagents.field.completionGuard'),
      defaultContext: t('settings.varin.pluginSettings.subagents.field.defaultContext'),
      defaultProvider: t('settings.varin.pluginSettings.subagents.field.defaultProvider'),
      defaultReads: t('settings.varin.pluginSettings.subagents.field.defaultReads'),
      disabled: t('settings.varin.pluginSettings.subagents.field.agentAvailability'),
      extensions: t('settings.varin.pluginSettings.subagents.field.extensions'),
      fallbackModels: t('settings.varin.pluginSettings.subagents.field.fallbackModels'),
      inheritProjectContext: t('settings.varin.pluginSettings.subagents.field.inheritProjectContext'),
      inheritSkills: t('settings.varin.pluginSettings.subagents.field.inheritSkills'),
      model: t('settings.varin.pluginSettings.subagents.field.primaryModel'),
      output: t('settings.varin.pluginSettings.subagents.field.defaultOutput'),
      outputMode: t('settings.varin.pluginSettings.subagents.field.outputMode'),
      skills: t('settings.varin.pluginSettings.subagents.field.skills'),
      subagentOnlyExtensions: t('settings.varin.pluginSettings.subagents.field.subagentExtensions'),
      thinking: t('settings.varin.pluginSettings.subagents.field.thinkingLevel'),
      toolBudget: t('settings.varin.pluginSettings.subagents.field.toolBudget'),
      'toolBudget.block': t('settings.varin.pluginSettings.subagents.field.toolsAfterBudget'),
      'toolBudget.hard': t('settings.varin.pluginSettings.subagents.field.toolBudgetHard'),
      'toolBudget.soft': t('settings.varin.pluginSettings.subagents.field.toolBudgetSoft'),
      tools: t('settings.varin.pluginSettings.subagents.field.allowedTools'),
    };
    return t('settings.varin.pluginSettings.subagents.overrides.validationField', {
      agent,
      field: overrideLabels[overrideField] ?? t('settings.varin.pluginSettings.subagents.overrides.advancedField'),
    });
  }, [t]);
  const issueMessage = React.useCallback((issue: SubagentsDraftIssue): string => {
    const field = issueFieldLabel(issue.field);
    switch (issue.code) {
      case 'model-scope-allow-required':
        return t('settings.varin.pluginSettings.subagents.validation.modelScopeAllow');
      case 'required':
        return t('settings.varin.pluginSettings.subagents.validation.required', { field });
      case 'invalid-number':
        return t('settings.varin.pluginSettings.subagents.validation.invalidNumber', { field });
      case 'invalid-value':
        return t('settings.varin.pluginSettings.subagents.validation.invalidValue', { field });
      case 'soft-exceeds-hard':
        return t('settings.varin.pluginSettings.subagents.validation.softExceedsHard', { field });
    }
  }, [issueFieldLabel, t]);

  const settingsFields: FieldBindings = {
    disabled: !settings.loaded || settings.loading || settings.saving || settingsTrustBlocked || settings.rawError !== null,
    draft: settings.draft,
    onRemove: settings.removeValue,
    onSet: settings.setValue,
  };
  const runtimeFields: FieldBindings = {
    disabled: !runtime.loaded || runtime.loading || runtime.saving || runtime.rawError !== null,
    draft: runtime.draft,
    onRemove: runtime.removeValue,
    onSet: runtime.setValue,
  };
  const waitToolValue = readJsonPath(runtime.draft, ['waitTool']);
  const waitToolDraft = typeof waitToolValue === 'boolean'
    ? { ...runtime.draft, waitTool: { enabled: waitToolValue } }
    : runtime.draft;
  const proactiveValue = readJsonPath(runtime.draft, ['proactiveSkillSubagents']);
  const proactiveDraft = proactiveValue === false
    ? setJsonPath(runtime.draft, ['proactiveSkillSubagents'], { enabled: false })
    : runtime.draft;
  const proactiveFields: FieldBindings = {
    ...runtimeFields,
    draft: proactiveDraft,
    onRemove: (path) => {
      if (proactiveValue === false && path[0] === 'proactiveSkillSubagents') runtime.removeValue(['proactiveSkillSubagents']);
      else runtime.removeValue(path);
    },
    onSet: (path, value) => {
      if (proactiveValue === false && path[0] === 'proactiveSkillSubagents') {
        runtime.setValue(['proactiveSkillSubagents'], setJsonPath({ enabled: false }, path.slice(1), value));
      } else runtime.setValue(path, value);
    },
  };
  const pluginDefault = t('settings.varin.pluginSettings.field.pluginDefault');
  const unlimited = t('settings.varin.pluginSettings.subagents.value.unlimited');
  const panelOptions: Array<{ value: SubagentsPanel; label: string }> = [
    { value: 'catalog', label: tx('settings.varin.pluginSettings.subagents.panel.catalog') },
    { value: 'delegation', label: tx('settings.varin.pluginSettings.subagents.panel.delegation') },
    { value: 'review', label: tx('settings.varin.pluginSettings.subagents.panel.review') },
    { value: 'limits', label: tx('settings.varin.pluginSettings.subagents.panel.limits') },
  ];
  const thinkingOptions = THINKING_LEVELS.map((level) => ({
    value: level,
    label: tx(`settings.varin.pluginSettings.subagents.thinking.${level}`),
  }));

  const settingsHeader = (title: string, description: string) => (
    <div className="flex flex-col gap-3 @xl:flex-row @xl:items-start @xl:justify-between">
      <div className="space-y-1">
        <h3 className="typography-settings-group-title text-foreground">{title}</h3>
        <p className="typography-meta text-muted-foreground">{description}</p>
      </div>
      <ScopeSelector value={scope} onChange={setScope} disabled={globalSettings.saving || projectSettings.saving} />
    </div>
  );

  const settingsFooter = (
    <>
      <PluginAdvancedDraftEditor controller={settings} blocked={settingsTrustBlocked} />
      <PluginDraftFooter
        controller={settings}
        blocked={settingsTrustBlocked || settingsIssue !== null}
        blockedMessage={settingsTrustBlocked || !settingsIssue ? undefined : issueMessage(settingsIssue)}
      />
    </>
  );
  const runtimeFooter = (
    <>
      <PluginAdvancedDraftEditor controller={runtime} />
      <PluginDraftFooter
        controller={runtime}
        blocked={runtimeIssue !== null}
        blockedMessage={runtimeIssue ? issueMessage(runtimeIssue) : undefined}
      />
    </>
  );

  return (
    <div className="space-y-8">
      <PluginRuntimeNote>{t('settings.varin.pluginSettings.subagents.runtimeNote')}</PluginRuntimeNote>
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => setSettingsPage('agents')}>{t('settings.page.agents.title')}</Button>
      </div>
      <SettingsChipGroup value={panel} options={panelOptions} onChange={setPanel} aria-label={tx('settings.varin.pluginSettings.subagents.panel.aria')} />

      {panel === 'catalog' ? (
        <div className="space-y-5">
          {settingsHeader(
            tx('settings.varin.pluginSettings.subagents.panel.catalog'),
            tx('settings.varin.pluginSettings.subagents.catalog.panelDescription'),
          )}
          <PluginRuntimeNote>
            {tx(scope === 'project'
              ? 'settings.varin.pluginSettings.subagents.authority.projectSettings'
              : 'settings.varin.pluginSettings.subagents.authority.userSettings')}
          </PluginRuntimeNote>
          <PluginConfigSource controller={settings} />
          <SubagentsAgentOverrides
            {...settingsFields}
            runtimeTarget={runtimeTarget}
            scope={scope === 'project' ? 'project' : 'user'}
            targetKey={`${targetKey}:catalog`}
          />
          {settingsFooter}
        </div>
      ) : null}

      {panel === 'delegation' ? (
        <div className="space-y-6">
          <div className="space-y-5">
            {settingsHeader(
              tx('settings.varin.pluginSettings.subagents.delegation.defaultsTitle'),
              tx('settings.varin.pluginSettings.subagents.delegation.defaultsDescription'),
            )}
            <PluginRuntimeNote>
              {tx(scope === 'project'
                ? 'settings.varin.pluginSettings.subagents.authority.projectSettings'
                : 'settings.varin.pluginSettings.subagents.authority.userSettings')}
            </PluginRuntimeNote>
            <PluginConfigSource controller={settings} />
            <SettingsControlGroup title={tx('settings.varin.pluginSettings.subagents.delegation.modelDefaults')} contentClassName="space-y-4">
              <PluginModelField {...settingsFields} path={['defaultModel']} label={tx('settings.varin.pluginSettings.subagents.field.defaultModel')} placeholder={tx('settings.varin.pluginSettings.subagents.value.inheritModel')} />
              <PluginStringField {...settingsFields} path={['defaultProvider']} label={tx('settings.varin.pluginSettings.subagents.field.defaultProvider')} placeholder="openai" />
              <PluginOptionalSelectField {...settingsFields} path={['defaultThinking']} label={tx('settings.varin.pluginSettings.subagents.field.defaultThinking')} options={thinkingOptions} />
              <PluginOptionalSelectField {...settingsFields} path={['maxThinking']} label={tx('settings.varin.pluginSettings.subagents.field.maxThinking')} options={thinkingOptions} />
              <PluginStringListField {...settingsFields} path={['defaultExtensions']} label={tx('settings.varin.pluginSettings.subagents.field.defaultExtensions')} placeholder="extension/path.ts" emptyArrayOnClear />
              <PluginBooleanField {...settingsFields} path={['disableThinking']} label={tx('settings.varin.pluginSettings.subagents.field.disableThinking')} defaultValue={false} />
            </SettingsControlGroup>
            <SettingsControlGroup className={SUBGROUP_CLASS} title={tx('settings.varin.pluginSettings.subagents.delegation.modelAccess')} description={tx('settings.varin.pluginSettings.subagents.delegation.modelAccessDescription')} contentClassName="space-y-4">
              <PluginBooleanField {...settingsFields} path={['disableBuiltins']} label={tx('settings.varin.pluginSettings.subagents.field.disableBuiltins')} defaultValue={false} />
              <PluginBooleanField {...settingsFields} path={['modelScope', 'enforce']} label={tx('settings.varin.pluginSettings.subagents.field.enforceModelAllowlist')} defaultValue={false} />
              <PluginBooleanField {...settingsFields} path={['modelScope', 'strict']} label={tx('settings.varin.pluginSettings.subagents.field.strictModelAllowlist')} defaultValue={false} />
              <PluginStringListField {...settingsFields} path={['modelScope', 'allow']} label={tx('settings.varin.pluginSettings.subagents.field.allowedModels')} placeholder="provider/*" />
            </SettingsControlGroup>
            {scope === 'project' ? (
              <SettingsControlGroup className={SUBGROUP_CLASS} title={tx('settings.varin.pluginSettings.subagents.delegation.projectContext')} contentClassName="space-y-4">
                <PluginSelectField {...settingsFields} path={['projectRootResolution']} label={tx('settings.varin.pluginSettings.subagents.field.projectRoot')} defaultValue="nearest" options={[
                  { value: 'nearest', label: tx('settings.varin.pluginSettings.subagents.projectRoot.nearest') },
                  { value: 'git-root', label: tx('settings.varin.pluginSettings.subagents.projectRoot.gitRoot') },
                ]} />
              </SettingsControlGroup>
            ) : null}
            {settingsFooter}
          </div>

          <div className="space-y-5 border-t border-border/60 pt-6">
            <div className="space-y-1">
              <h3 className="typography-settings-group-title text-foreground">{tx('settings.varin.pluginSettings.subagents.delegation.runtimeTitle')}</h3>
              <p className="typography-meta text-muted-foreground">{tx('settings.varin.pluginSettings.subagents.delegation.runtimeDescription')}</p>
            </div>
            <PluginRuntimeNote>{tx('settings.varin.pluginSettings.subagents.authority.globalRuntime')}</PluginRuntimeNote>
            <PluginConfigSource controller={runtime} />
            <SettingsControlGroup title={tx('settings.varin.pluginSettings.subagents.delegation.behavior')} contentClassName="space-y-4">
              <PluginBooleanField {...runtimeFields} path={['asyncByDefault']} label={tx('settings.varin.pluginSettings.subagents.field.asyncByDefault')} defaultValue={false} />
              <PluginBooleanField {...runtimeFields} draft={waitToolDraft} path={['waitTool', 'enabled']} label={tx('settings.varin.pluginSettings.subagents.field.waitTool')} defaultValue />
              <PluginOptionalBooleanField {...proactiveFields} path={['proactiveSkillSubagents', 'enabled']} label={tx('settings.varin.pluginSettings.subagents.field.proactiveDelegation')} />
              <PluginNumberField {...runtimeFields} path={['maxSubagentDepth']} label={tx('settings.varin.pluginSettings.subagents.field.maximumDepth')} defaultValue={2} min={0} />
              <PluginNumberField {...runtimeFields} path={['globalConcurrencyLimit']} label={tx('settings.varin.pluginSettings.subagents.field.globalConcurrency')} defaultValue={20} min={1} />
            </SettingsControlGroup>
            {runtimeFooter}
          </div>
        </div>
      ) : null}

      {panel === 'review' ? (
        <div className="space-y-5">
          {settingsHeader(
            tx('settings.varin.pluginSettings.subagents.review.title'),
            tx('settings.varin.pluginSettings.subagents.review.description'),
          )}
          <PluginRuntimeNote>
            {tx(scope === 'project'
              ? 'settings.varin.pluginSettings.subagents.authority.projectSettings'
              : 'settings.varin.pluginSettings.subagents.authority.userSettings')}
          </PluginRuntimeNote>
          <PluginConfigSource controller={settings} />
          <SettingsControlGroup title={tx('settings.varin.pluginSettings.subagents.review.watchdog')} contentClassName="space-y-4">
            <PluginBooleanField {...settingsFields} path={['watchdog', 'enabled']} label={tx('settings.varin.pluginSettings.subagents.field.watchdogEnabled')} defaultValue={false} />
            <PluginBooleanField {...settingsFields} path={['watchdog', 'showDuringRun']} label={tx('settings.varin.pluginSettings.subagents.field.showWatchdog')} defaultValue={false} />
            <PluginSelectField {...settingsFields} path={['watchdog', 'severityThreshold']} label={tx('settings.varin.pluginSettings.subagents.field.reviewSeverity')} defaultValue="concern" options={[
              { value: 'concern', label: tx('settings.varin.pluginSettings.subagents.severity.concern') },
              { value: 'blocker', label: tx('settings.varin.pluginSettings.subagents.severity.blocker') },
            ]} />
          </SettingsControlGroup>
          <SettingsControlGroup className={SUBGROUP_CLASS} title={tx('settings.varin.pluginSettings.subagents.review.mainAgent')} contentClassName="space-y-4">
            <PluginOptionalBooleanField {...settingsFields} path={['watchdog', 'main', 'enabled']} label={tx('settings.varin.pluginSettings.subagents.field.reviewMainAgent')} />
            <PluginModelField {...settingsFields} path={['watchdog', 'main', 'model']} label={tx('settings.varin.pluginSettings.subagents.field.reviewMainModel')} placeholder={tx('settings.varin.pluginSettings.subagents.value.inheritModel')} />
            <PluginOptionalSelectField {...settingsFields} path={['watchdog', 'main', 'thinking']} label={tx('settings.varin.pluginSettings.subagents.field.reviewMainThinking')} options={thinkingOptions} />
            <PluginBooleanField {...settingsFields} path={['watchdog', 'autoFollow', 'blockers']} label={tx('settings.varin.pluginSettings.subagents.field.followMainBlockers')} defaultValue />
            <PluginOptionalNumberField {...settingsFields} path={['watchdog', 'autoFollow', 'maxAttempts']} label={tx('settings.varin.pluginSettings.subagents.field.maximumFollowups')} defaultValue={3} emptyValue={null} emptyLabel={unlimited} min={1} fallbackValue={1} />
          </SettingsControlGroup>
          <SettingsControlGroup className={SUBGROUP_CLASS} title={tx('settings.varin.pluginSettings.subagents.review.childAgents')} contentClassName="space-y-4">
            <PluginBooleanField {...settingsFields} path={['watchdog', 'children', 'enabled']} label={tx('settings.varin.pluginSettings.subagents.field.reviewChildAgents')} defaultValue={false} />
            <PluginModelField {...settingsFields} path={['watchdog', 'children', 'model']} label={tx('settings.varin.pluginSettings.subagents.field.reviewChildModel')} placeholder={tx('settings.varin.pluginSettings.subagents.value.inheritModel')} />
            <PluginOptionalSelectField {...settingsFields} path={['watchdog', 'children', 'thinking']} label={tx('settings.varin.pluginSettings.subagents.field.reviewChildThinking')} options={thinkingOptions} />
            <PluginBooleanField {...settingsFields} path={['watchdog', 'children', 'autoFollow', 'blockers']} label={tx('settings.varin.pluginSettings.subagents.field.followChildBlockers')} defaultValue />
            <PluginOptionalNumberField {...settingsFields} path={['watchdog', 'children', 'autoFollow', 'maxAttempts']} label={tx('settings.varin.pluginSettings.subagents.field.maximumChildFollowups')} defaultValue={3} emptyValue={null} emptyLabel={unlimited} min={1} fallbackValue={1} />
          </SettingsControlGroup>
          {settingsFooter}
        </div>
      ) : null}

      {panel === 'limits' ? (
        <div className="space-y-5">
          <div className="space-y-1">
            <h3 className="typography-settings-group-title text-foreground">{tx('settings.varin.pluginSettings.subagents.limits.title')}</h3>
            <p className="typography-meta text-muted-foreground">{tx('settings.varin.pluginSettings.subagents.limits.description')}</p>
          </div>
          <PluginRuntimeNote>{tx('settings.varin.pluginSettings.subagents.authority.globalRuntime')}</PluginRuntimeNote>
          <PluginConfigSource controller={runtime} />
          <SettingsControlGroup title={tx('settings.varin.pluginSettings.subagents.limits.capacity')} contentClassName="space-y-4">
            <PluginNumberField {...runtimeFields} path={['maxSubagentDepth']} label={tx('settings.varin.pluginSettings.subagents.field.maximumDepth')} defaultValue={2} min={0} />
            <PluginNumberField {...runtimeFields} path={['maxSubagentSpawnsPerSession']} label={tx('settings.varin.pluginSettings.subagents.field.maximumSpawns')} description={t('settings.varin.pluginSettings.subagents.unlimitedZero')} defaultValue={0} min={0} />
            <PluginNumberField {...runtimeFields} path={['globalConcurrencyLimit']} label={tx('settings.varin.pluginSettings.subagents.field.globalConcurrency')} defaultValue={20} min={1} />
            <PluginNumberField {...runtimeFields} path={['parallel', 'maxTasks']} label={tx('settings.varin.pluginSettings.subagents.field.parallelTaskLimit')} defaultValue={8} min={1} />
            <PluginNumberField {...runtimeFields} path={['parallel', 'concurrency']} label={tx('settings.varin.pluginSettings.subagents.field.parallelConcurrency')} defaultValue={4} min={1} />
            <PluginOptionalNumberField {...runtimeFields} path={['chain', 'dynamicFanout', 'maxItems']} label={tx('settings.varin.pluginSettings.subagents.field.dynamicFanout')} emptyLabel={pluginDefault} min={0} fallbackValue={0} />
          </SettingsControlGroup>
          <SettingsControlGroup className={SUBGROUP_CLASS} title={tx('settings.varin.pluginSettings.subagents.limits.hardBudgets')} description={tx('settings.varin.pluginSettings.subagents.limits.hardBudgetsDescription')} contentClassName="space-y-4">
            <PluginOptionalNumberField {...runtimeFields} path={['turnBudget', 'maxTurns']} label={tx('settings.varin.pluginSettings.subagents.field.turnLimit')} emptyLabel={pluginDefault} min={1} fallbackValue={1} />
            <PluginNumberField {...runtimeFields} path={['turnBudget', 'graceTurns']} label={tx('settings.varin.pluginSettings.subagents.field.turnGrace')} defaultValue={1} min={0} />
            <PluginOptionalNumberField {...runtimeFields} path={['toolBudget', 'soft']} label={tx('settings.varin.pluginSettings.subagents.field.toolSoftLimit')} emptyLabel={pluginDefault} min={1} fallbackValue={1} />
            <PluginOptionalNumberField {...runtimeFields} path={['toolBudget', 'hard']} label={tx('settings.varin.pluginSettings.subagents.field.toolHardLimit')} emptyLabel={pluginDefault} min={1} fallbackValue={1} />
            <PluginOptionalNumberField {...runtimeFields} path={['usageBudget', 'tokens', 'soft']} label={tx('settings.varin.pluginSettings.subagents.field.tokenSoftLimit')} emptyLabel={pluginDefault} min={1} fallbackValue={1} />
            <PluginOptionalNumberField {...runtimeFields} path={['usageBudget', 'tokens', 'hard']} label={tx('settings.varin.pluginSettings.subagents.field.tokenHardLimit')} emptyLabel={pluginDefault} min={1} fallbackValue={1} />
            <PluginOptionalNumberField {...runtimeFields} path={['usageBudget', 'costUsd', 'soft']} label={tx('settings.varin.pluginSettings.subagents.field.costSoftLimit')} emptyLabel={pluginDefault} min={0.000001} step={0.000001} fallbackValue={0.01} unit="USD" />
            <PluginOptionalNumberField {...runtimeFields} path={['usageBudget', 'costUsd', 'hard']} label={tx('settings.varin.pluginSettings.subagents.field.costHardLimit')} emptyLabel={pluginDefault} min={0.000001} step={0.000001} fallbackValue={0.01} unit="USD" />
          </SettingsControlGroup>
          {runtimeFooter}
        </div>
      ) : null}
    </div>
  );
};
