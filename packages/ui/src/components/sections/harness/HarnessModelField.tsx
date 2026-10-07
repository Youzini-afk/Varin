import React from 'react';
import type { HarnessModelRole } from '@varin/protocol';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { Switch } from '@/components/ui/switch';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useI18n } from '@/lib/i18n';
import type { HarnessSettingsPageProps } from './harness-settings-state';

export function HarnessModelField({ harness, update, slot, enableControl = true }: HarnessSettingsPageProps & { slot: HarnessModelRole; enableControl?: boolean }) {
  const { t } = useI18n();
  const cwd = useDirectoryStore((state) => state.currentDirectory);
  const selected = harness.models[slot];
  const inherited = slot === 'worker';
  const label = t(slot === 'explore' ? 'settings.page.harness.codeRetrieval.mode.llm' : `settings.harness.role.${slot}`);
  const emptyLabel = t(inherited ? 'settings.page.harness.models.mainModel' : 'settings.harness.models.noModel');
  return <div className="flex min-w-0 flex-col gap-2 py-2 @xl:flex-row @xl:items-center @xl:justify-between @xl:gap-6" data-settings-item={`harness.models.${slot}`}>
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-3"><p className="typography-settings-field-label">{label}</p>
        {enableControl && <Switch checked={selected?.enabled !== false} aria-label={label}
          onCheckedChange={(enabled) => update({ models: { [slot]: { enabled } } })} />}</div>
      {slot !== 'explore' ? <p className="mt-1 typography-meta text-muted-foreground">{t(`settings.harness.role.${slot}.description`)}</p> : null}
    </div>
    <div className="w-full min-w-0 @xl:w-72 @xl:shrink-0">
      <ModelSelector cwd={cwd} providerId={selected?.providerId ?? ''} modelId={selected?.modelId ?? ''}
        className="w-full max-w-none" allowNone placeholder={emptyLabel} defaultSelectionLabel={emptyLabel}
        onChange={(providerId, modelId) => update({ models: { [slot]: { providerId: providerId || undefined, modelId: modelId || undefined } } })} />
      {slot !== 'explore' && !selected?.modelId ? <p className="mt-1 typography-meta text-muted-foreground">{t(inherited
        ? 'settings.page.harness.models.slot.mainFallback' : 'settings.page.harness.models.slot.optional')}</p> : null}
    </div>
  </div>;
}
