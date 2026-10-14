import React from 'react';
import type { ThreadIdentity, ThreadThinkingLevel, ThreadModelInfo } from '@varin/application-client';
import { getRuntimeEndpointGeneration } from '@varin/application-client';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { ThinkingPill } from '@/components/session/ThinkingPill';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useI18n } from '@/lib/i18n';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useThreadStore } from '@/stores/useThreadStore';
import { reviewModel } from '@/lib/reviewFlow';

export type ReviewFlowExecution = {
  autoReview: boolean;
  generateHandoff: boolean;
  modelId: string;
  providerId: string;
  thinkingLevel: ThreadThinkingLevel;
  maxIterations: number;
};

type ReviewFlowDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  original?: ThreadIdentity | null;
  projectDirectory: string | null;
  submitting?: boolean;
  onConfirm: (execution: ReviewFlowExecution) => Promise<void> | void;
};

const initialExecution = (
  providerId = '',
  modelId = '',
  thinkingLevel: ThreadThinkingLevel = 'off',
): ReviewFlowExecution => ({
  maxIterations: 15,
  autoReview: false,
  generateHandoff: true,
  modelId,
  providerId,
  thinkingLevel,
});

export function ReviewFlowDialog({
  open,
  onOpenChange,
  original,
  submitting = false,
  onConfirm,
}: ReviewFlowDialogProps) {
  const { t } = useI18n();
  const api = useRuntimeAPIs().threads;
  const hostKey = useThreadStore(state => state.hostKey);
  const [models, setModels] = React.useState<ThreadModelInfo[]>([]);
  const [error, setError] = React.useState<string>();
  const [execution, setExecution] = React.useState<ReviewFlowExecution>(() => initialExecution());
  React.useEffect(() => {
    if (!open || !api) return;
    let alive = true;
    const generation = getRuntimeEndpointGeneration();
    setModels([]); setError(undefined); setExecution(initialExecution());
    void Promise.all([api.listModels(), original ? api.snapshot(original) : Promise.resolve(undefined)]).then(([models, snapshot]) => {
      if (!alive || generation !== getRuntimeEndpointGeneration()) return;
      setModels(models);
      const selected = snapshot ? reviewModel(snapshot) : undefined;
      const model = models.find(item => item.providerId === selected?.providerId && item.modelId === selected.modelId) ?? models[0];
      if (model) setExecution(initialExecution(model.providerId, model.modelId, model.thinkingLevels?.includes(selected?.thinkingLevel ?? 'off') ? selected?.thinkingLevel : model.thinkingLevels?.[0]));
    }).catch(error => { if (alive && generation === getRuntimeEndpointGeneration()) setError(error instanceof Error ? error.message : 'Model catalog unavailable'); });
    return () => { alive = false; };
  }, [api, open, original, hostKey]);
  const selectedModel = models.find(model => model.providerId === execution.providerId && model.modelId === execution.modelId);
  const thinkingOptions = selectedModel?.thinkingLevels ?? [];
  const canConfirm = Boolean(selectedModel) && (!execution.autoReview || Number.isSafeInteger(execution.maxIterations) && execution.maxIterations > 0);

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

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!submitting) onOpenChange(nextOpen); }}>
      <DialogContent className="max-w-md overflow-visible">
        <DialogHeader>
          <DialogTitle>{t('diffView.reviewDialog.title')}</DialogTitle>
          <DialogDescription>{t('diffView.reviewDialog.description')}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="rounded-md border border-[color:color-mix(in_srgb,var(--status-info)_35%,var(--interactive-border))] bg-[color:color-mix(in_srgb,var(--status-info)_10%,var(--surface-background))] px-3 py-2 typography-meta text-foreground">
            {t('diffView.reviewDialog.info')}
          </div>

          <label className="flex items-center gap-2 typography-ui-label text-foreground">
            <Checkbox
              checked={execution.generateHandoff}
              onChange={(generateHandoff) => setExecution((current) => ({ ...current, generateHandoff }))}
              disabled={submitting}
              ariaLabel={t('diffView.reviewDialog.generateHandoff')}
            />
            <span>{t('diffView.reviewDialog.generateHandoff')}</span>
          </label>

          <label className="flex items-center gap-2 typography-ui-label text-foreground">
            <Checkbox
              checked={execution.autoReview}
              onChange={(autoReview) => setExecution((current) => ({ ...current, autoReview }))}
              disabled={submitting}
              ariaLabel={t('diffView.reviewDialog.autoReview')}
            />
            <span>{t('diffView.reviewDialog.autoReview')}</span>
          </label>

          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="typography-meta font-medium text-muted-foreground">{t('chat.modelControls.model')}</span>
            <ModelSelector
              providerId={execution.providerId}
              modelId={execution.modelId}
              className="max-w-[320px] justify-between"
              dropdownPortalToBody
              onChange={(providerId, modelId) => {
                const model = models.find(entry => entry.providerId === providerId && entry.modelId === modelId);
                setExecution((current) => ({
                  ...current,
                  modelId,
                  providerId,
                  thinkingLevel: model?.thinkingLevels?.includes(current.thinkingLevel)
                    ? current.thinkingLevel
                    : model?.thinkingLevels?.[0] ?? 'off',
                }));
              }}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="typography-meta font-medium text-muted-foreground">{t('sessions.scheduledTasks.editor.thinkingLevel.label')}</span>
            <ThinkingPill
              value={execution.thinkingLevel}
              options={thinkingOptions}
              disabled={thinkingOptions.length === 0 || submitting}
              onChange={(thinkingLevel) => setExecution((current) => ({
                ...current,
                thinkingLevel: thinkingLevel as ThreadThinkingLevel,
              }))}
            />
          </div>

          {execution.autoReview && <label className="flex flex-col gap-1.5 typography-meta">
            Maximum implementation rounds
            <input type="number" min={1} step={1} value={execution.maxIterations} disabled={submitting}
              onChange={event => setExecution(current => ({ ...current, maxIterations: Number(event.target.value) }))} />
            <span>Automatic forwarding runs while this app stays open. Stopping forwarding leaves accepted runs available in their conversations.</span>
          </label>}
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t('diffView.reviewDialog.actions.cancel')}
          </Button>
          <Button size="sm" onClick={handleSubmit} disabled={!canConfirm || submitting}>
            {submitting ? t('diffView.reviewDialog.actions.starting') : t('diffView.reviewDialog.actions.start')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
