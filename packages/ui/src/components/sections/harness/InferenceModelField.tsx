import React from 'react';
import { ModelLogo } from '@/components/ui/ModelLogo';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useI18n } from '@/lib/i18n';
import { AutoSaveInput } from './AutoSaveInput';

/** Declared inference models are suggestions. An undiscovered model can still be entered explicitly. */
export function InferenceModelField({ models, value, onCommit, label, placeholder }: {
  models: readonly { id: string; name?: string; requestModelId?: string }[];
  value: string;
  onCommit: (id: string) => void;
  label: string;
  placeholder: string;
}) {
  const { t } = useI18n();
  // An unloaded catalog should not pin an already configured model to manual mode.
  const [manual, setManual] = React.useState(false);
  const inputGeneration = React.useRef(0);
  const [generation, setGeneration] = React.useState(0);
  const selected = models.find(model => model.id === value);
  return <div className="w-full space-y-2">
    {models.length > 0 && <Select value={manual || !selected ? '__manual' : `model:${value}`} onValueChange={id => {
      setManual(id === '__manual');
      if (id !== '__manual') {
        inputGeneration.current += 1;
        setGeneration(inputGeneration.current);
        onCommit(id.slice('model:'.length));
      }
    }}>
      <SelectTrigger size="settings" className="w-full" aria-label={label}>
        <SelectValue>{manual || !selected ? t('settings.harness.models.manualModel') : <span className="flex min-w-0 items-center gap-2"><ModelLogo modelId={selected.id} requestModelId={selected.requestModelId} displayName={selected.name} /><span className="truncate">{selected.name || selected.id}</span></span>}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {models.map(model => <SelectItem key={model.id} value={`model:${model.id}`}><span className="flex min-w-0 items-center gap-2"><ModelLogo modelId={model.id} requestModelId={model.requestModelId} displayName={model.name} /><span className="truncate">{model.name || model.id}</span></span></SelectItem>)}
        <SelectItem value="__manual">{t('settings.harness.models.manualModel')}</SelectItem>
      </SelectContent>
    </Select>}
    {(manual || !selected || models.length === 0) && <AutoSaveInput value={value} onCommit={id => {
      if (generation === inputGeneration.current) onCommit(id);
    }} placeholder={placeholder} aria-label={label} />}
  </div>;
}
