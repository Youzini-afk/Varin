import React from 'react';
import type { ThinkingLevel } from '@varin/protocol';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useI18n } from '@/lib/i18n';
import { useModelCatalogStore } from '@/stores/useModelCatalogStore';
import { useThreadStore, threadIdentityKey } from '@/stores/useThreadStore';
import { useThreadDraftStore } from '@/stores/useThreadDraftStore';

type TodoSendTarget = 'session' | 'worktree';

export interface TodoSendExecution {
  modelID: string;
  providerID: string;
  runAsGoal?: boolean;
  thinkingLevel: ThinkingLevel;
}

interface TodoSendDialogProps {
  allowRunAsGoal?: boolean;
  onConfirm(execution: TodoSendExecution): Promise<void> | void;
  onOpenChange(open: boolean): void;
  open: boolean;
  projectDirectory: string | null;
  submitting?: boolean;
  target: TodoSendTarget;
}

const modelKey = (model: {id: string; provider: string}): string => (
  JSON.stringify([model.provider, model.id])
);

const parseModelKey = (value: string): { id: string; provider: string } | null => {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [provider, id] = parsed;
    return typeof provider === 'string' && typeof id === 'string' ? { id, provider } : null;
  } catch {
    return null;
  }
};

export function TodoSendDialog({
  allowRunAsGoal = false,
  onConfirm,
  onOpenChange,
  open,
  projectDirectory,
  submitting = false,
  target,
}: TodoSendDialogProps) {
  const { t } = useI18n();
  const identity = useThreadStore(state => state.selectedIdentity);
  const host = useThreadStore(state => state.hostKey);
  const currentModel = useThreadDraftStore(state => identity ? state.drafts[threadIdentityKey(host, identity)]?.model : undefined);
  const providers = useModelCatalogStore(state => state.channels);
  const loading = useModelCatalogStore(state => state.loading);
  const error = useModelCatalogStore(state => state.error);
  const load = useModelCatalogStore(state => state.load);
  const [execution, setExecution] = React.useState<TodoSendExecution>({
    modelID: '',
    providerID: '',
    thinkingLevel: 'off',
  });

  React.useEffect(() => {
    if (!open || !projectDirectory) return;
    void load().catch(() => undefined);
  }, [load, open, projectDirectory]);

  const models = React.useMemo(() => providers
    .filter(provider => provider.enabled)
    .flatMap(provider => provider.models.filter(model => model.enabled && model.operations.includes('chat')).map(model => ({ ...model, provider: provider.id, supportedThinkingLevels: (Object.keys(model.thinkingLevelMap ?? {}).length ? Object.keys(model.thinkingLevelMap!) : ['off']) as ThinkingLevel[] })))
    .sort((left, right) => `${left.provider}/${left.name}`.localeCompare(`${right.provider}/${right.name}`)), [providers]);

  React.useEffect(() => {
    if (!open || models.length === 0) return;
    const current = models.find((model) => (
      model.provider === currentModel?.providerId && model.id === currentModel?.modelId
    ));
    const selected = models.find((model) => (
      model.provider === execution.providerID && model.id === execution.modelID
    ));
    const model = selected ?? current ?? models[0];
    if (!model) return;
    const currentThinking = currentModel?.thinkingLevel;
    const thinkingLevel = model.supportedThinkingLevels.includes(execution.thinkingLevel)
      ? execution.thinkingLevel
      : currentThinking && model.supportedThinkingLevels.includes(currentThinking)
        ? currentThinking
        : model.supportedThinkingLevels[0] ?? 'off';
    if (
      execution.providerID === model.provider
      && execution.modelID === model.id
      && execution.thinkingLevel === thinkingLevel
    ) return;
    setExecution((value) => ({
      ...value,
      modelID: model.id,
      providerID: model.provider,
      thinkingLevel,
    }));
  }, [currentModel, currentModel?.thinkingLevel, execution.modelID, execution.providerID, execution.thinkingLevel, models, open]);

  const selectedModel = models.find((model) => (
    model.provider === execution.providerID && model.id === execution.modelID
  ));
  const canConfirm = selectedModel !== undefined && !loading;
  const handleSubmit = React.useCallback(() => {
    if (!canConfirm || submitting) return;
    void onConfirm(execution);
  }, [canConfirm, execution, onConfirm, submitting]);

  React.useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        handleSubmit();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleSubmit, open]);

  const title = target === 'worktree'
    ? t('rightSidebar.contextNotesTodo.sendDialog.title.newWorktree')
    : t('rightSidebar.contextNotesTodo.sendDialog.title.newSession');

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!submitting) onOpenChange(nextOpen); }}>
      <DialogContent className="max-w-md overflow-visible">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <label className="flex min-w-0 flex-col gap-1.5">
            <span className="typography-meta font-medium text-muted-foreground">{t('chat.modelControls.model')}</span>
            <select
              value={selectedModel ? modelKey(selectedModel) : ''}
              onChange={(event) => {
                const next = parseModelKey(event.target.value);
                const model = next ? models.find((candidate) => candidate.provider === next.provider && candidate.id === next.id) : undefined;
                if (!model) return;
                setExecution((current) => ({
                  ...current,
                  modelID: model.id,
                  providerID: model.provider,
                  thinkingLevel: model.supportedThinkingLevels.includes(current.thinkingLevel)
                    ? current.thinkingLevel
                    : model.supportedThinkingLevels[0] ?? 'off',
                }));
              }}
              disabled={loading || models.length === 0}
              className="h-9 w-full rounded-md border border-border bg-background px-3 typography-ui-label text-foreground outline-none focus:border-primary"
            >
              {models.map((model) => (
                <option key={modelKey(model)} value={modelKey(model)}>
                  {model.name} ({model.provider}/{model.id})
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="typography-meta font-medium text-muted-foreground">{t('sessions.scheduledTasks.editor.thinkingLevel.label')}</span>
            <select
              value={execution.thinkingLevel}
              onChange={(event) => setExecution((current) => ({
                ...current,
                thinkingLevel: event.target.value as ThinkingLevel,
              }))}
              disabled={!selectedModel || selectedModel.supportedThinkingLevels.length === 0}
              className="h-9 w-full rounded-md border border-border bg-background px-3 typography-ui-label text-foreground outline-none focus:border-primary"
            >
              {(selectedModel?.supportedThinkingLevels ?? ['off']).map((level) => (
                <option key={level} value={level}>{level}</option>
              ))}
            </select>
          </label>

          {loading && <p className="typography-meta text-muted-foreground">Loading models...</p>}
          {error && !loading && <p className="typography-meta text-[var(--status-error)]">{error}</p>}
        </div>

        <div className={`flex items-center gap-3 ${allowRunAsGoal ? 'justify-between' : 'justify-end'}`}>
          {allowRunAsGoal && (
            <div className="flex min-w-0 items-center gap-2">
              <Checkbox
                checked={execution.runAsGoal === true}
                onChange={(runAsGoal: boolean) => setExecution((current) => ({ ...current, runAsGoal }))}
                disabled={submitting}
                ariaLabel={t('sessions.scheduledTasks.editor.goal.aria')}
              />
              <button
                type="button"
                className="truncate typography-ui-label text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                disabled={submitting}
                onClick={() => setExecution((current) => ({ ...current, runAsGoal: current.runAsGoal !== true }))}
              >
                {t('sessions.scheduledTasks.editor.goal.label')}
              </button>
            </div>
          )}
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={submitting}>
              {t('rightSidebar.contextNotesTodo.sendDialog.actions.cancel')}
            </Button>
            <Button size="sm" onClick={handleSubmit} disabled={!canConfirm || submitting}>
              {submitting
                ? t('rightSidebar.contextNotesTodo.sendDialog.actions.sending')
                : t('rightSidebar.contextNotesTodo.sendDialog.actions.send')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
