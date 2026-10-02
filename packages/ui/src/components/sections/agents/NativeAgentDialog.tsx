import React from 'react';
import type { JsonValue, PiAgentDescriptor, WorkFocusId } from '@varin/protocol';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/lib/i18n';
import { ModelSelector } from './ModelSelector';
import { nativeAgentLabel } from './agents-catalog-model';

const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};

interface Props {
  agent?: PiAgentDescriptor;
  cwd: string;
  onClose(): void;
  onSave(config: JsonValue): Promise<boolean>;
  busy: boolean;
  error?: string | null;
}

export function NativeAgentDialog({ agent, cwd, onClose, onSave, busy, error }: Props) {
  const { t } = useI18n();
  const config = agent?.definition?.config;
  const builtin = config?.kind === 'builtin';
  const emptyModelLabel = t(builtin && !['hardImplement', 'review'].includes(String(config?.slot))
    ? 'settings.harness.models.noModel' : 'settings.varin.agents.detail.inherited');
  const original = builtin ? record(config?.binding) : record(config?.agent);
  const model = builtin ? original : record(original.model);
  const [draft, setDraft] = React.useState(() => ({
    name: typeof original.name === 'string' ? original.name : '',
    description: typeof original.description === 'string' ? original.description : '',
    instructions: typeof original.instructions === 'string' ? original.instructions : '',
    enabled: original.enabled !== false,
    providerId: typeof model.providerId === 'string' ? model.providerId : '',
    modelId: typeof model.modelId === 'string' ? model.modelId : '',
    tools: Array.isArray(original.tools) ? original.tools.join(', ') : 'read, grep, find, ls',
    worktree: original.worktree === 'isolated' ? 'isolated' : 'none',
    workFocus: (Array.isArray(original.workFocus) ? original.workFocus : []) as WorkFocusId[],
  }));
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const model = draft.providerId && draft.modelId ? { providerId: draft.providerId, modelId: draft.modelId } : undefined;
    const value = builtin ? { enabled: draft.enabled, ...model } : {
      name: draft.name.trim(), description: draft.description, instructions: draft.instructions, enabled: draft.enabled,
      ...(model ? { model } : {}), tools: [...new Set(draft.tools.split(/[\n,]/u).map(tool => tool.trim()).filter(Boolean))],
      worktree: draft.worktree, workFocus: draft.workFocus,
    };
    if (await onSave(value)) onClose();
  };
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}><DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
    <DialogHeader><DialogTitle>{agent ? nativeAgentLabel(agent, t) : t('settings.varin.agents.definition.createAgent')}</DialogTitle>
      <DialogDescription>{t('settings.agents.native.description')}</DialogDescription></DialogHeader>
    <form onSubmit={(event) => { void save(event); }} className="space-y-4">
      <div className="flex items-center justify-between"><label htmlFor="native-agent-enabled" className="typography-ui-label">{t('settings.agents.enabled')}</label>
        <Switch id="native-agent-enabled" checked={draft.enabled} disabled={busy} onCheckedChange={(enabled) => setDraft({ ...draft, enabled })} /></div>
      {!builtin && <>
        <label className="block space-y-1 typography-meta">{t('settings.agents.name')}<Input required value={draft.name} disabled={busy} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
        <label className="block space-y-1 typography-meta">{t('settings.agents.description')}<Input value={draft.description} disabled={busy} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
      </>}
      <div className="space-y-1 typography-meta"><p>{t('settings.varin.agents.detail.model')}</p>
        <ModelSelector cwd={cwd} providerId={draft.providerId} modelId={draft.modelId} allowNone disabled={busy}
          placeholder={emptyModelLabel} defaultSelectionLabel={emptyModelLabel}
          className="w-full max-w-none" onChange={(providerId, modelId) => setDraft({ ...draft, providerId, modelId })} /></div>
      {!builtin && <>
        <label className="block space-y-1 typography-meta">{t('settings.agents.instructions')}<Textarea rows={5} value={draft.instructions} disabled={busy} onChange={(event) => setDraft({ ...draft, instructions: event.target.value })} /></label>
        <label className="block space-y-1 typography-meta">{t('settings.agents.tools')}<Textarea rows={2} value={draft.tools} disabled={busy} onChange={(event) => setDraft({ ...draft, tools: event.target.value })} /></label>
        <p className="typography-meta text-muted-foreground">{t('settings.agents.toolsHint')}</p>
        <fieldset className="space-y-2"><legend className="typography-meta">{t('settings.agents.focus')}</legend><div className="flex gap-4">
          {(['code', 'research'] as const).map(focus => <label key={focus} className="flex items-center gap-2 typography-meta"><input type="checkbox" checked={draft.workFocus.includes(focus)} disabled={busy}
            onChange={(event) => setDraft({ ...draft, workFocus: event.target.checked ? [...draft.workFocus, focus] : draft.workFocus.filter(value => value !== focus) })} />{t(`workFocus.${focus}`)}</label>)}
        </div><p className="typography-meta text-muted-foreground">{t('settings.agents.focusHint')}</p></fieldset>
        <label className="flex items-center gap-2 typography-meta"><input type="checkbox" checked={draft.worktree === 'isolated'} disabled={busy} onChange={(event) => setDraft({ ...draft, worktree: event.target.checked ? 'isolated' : 'none' })} />{t('settings.agents.isolated')}</label>
      </>}
      {builtin && <details className="typography-meta"><summary className="cursor-pointer">{t('settings.agents.instructions')}</summary><p className="mt-2 whitespace-pre-wrap text-muted-foreground">{String(config?.instructions ?? '')}</p><p className="mt-2 break-words text-muted-foreground">{Array.isArray(config?.tools) ? config.tools.join(', ') : ''}</p></details>}
      {error && <p role="alert" className="typography-meta text-destructive">{error}</p>}
      <p className="typography-meta text-muted-foreground">{t('settings.agents.applies')}</p>
      <div className="flex justify-end gap-2"><Button type="button" variant="outline" disabled={busy} onClick={onClose}>{t('settings.common.actions.cancel')}</Button>
        <Button type="submit" disabled={busy || (!builtin && !draft.name.trim())}>{t('settings.common.actions.saveChanges')}</Button></div>
    </form>
  </DialogContent></Dialog>;
}
