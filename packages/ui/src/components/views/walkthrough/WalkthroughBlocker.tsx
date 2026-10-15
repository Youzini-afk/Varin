import { useCallback } from 'react';
import { Icon } from '@/components/icon/Icon';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import type { WalkthroughBlockedState, WalkthroughModel } from '@/lib/walkthrough/types';

interface WalkthroughBlockerProps {
  reason: WalkthroughBlockedState;
  model?: WalkthroughModel;
  requiredChars?: number;
  availableChars?: number;
  onRetry: () => void;
  onSelectModel: (providerId: string, modelId: string) => void;
}

const modelLabel = (model?: WalkthroughModel) =>
  model ? `${model.providerID}/${model.modelID}` : '';

/**
 * A refusal the user can act on. Both blocking reasons come down to "this small
 * model cannot do this job", so the remedy — pick a different one — is offered
 * in place rather than sending the user to Settings to guess.
 */
export const WalkthroughBlocker = ({
  reason,
  model,
  requiredChars,
  availableChars,
  onRetry,
  onSelectModel,
}: WalkthroughBlockerProps) => {
  const { t } = useI18n();

  // Every one of these means "this small model cannot do this job", so the
  // remedy is the same: choose a different one, here, without a detour through
  // Settings.
  const canChooseModel = reason === 'no-model' || reason === 'context-too-small'
    || reason === 'structured-output-unsupported'
    || reason === 'output-exhausted';

  const handleModelChange = useCallback((providerId: string, modelId: string) => {
    if (!providerId || !modelId) return;
    // A blocker is still one review. Keep its remedy at the same scope as the
    // header picker instead of silently changing the default for later reviews.
    onSelectModel(providerId, modelId);
  }, [onSelectModel]);

  // Name the model that was actually tried so the refusal is actionable.
  const label = modelLabel(model);

  const description = () => {
    if (reason === 'no-model') return t('walkthrough.blocked.noModel.description');
    if (reason === 'empty-diff') return t('walkthrough.blocked.emptyDiff.description');
    if (reason === 'only-generated') return t('walkthrough.blocked.onlyGenerated.description');
    if (reason === 'server-unsupported') return t('walkthrough.blocked.serverUnsupported.description');
    if (reason === 'output-exhausted') {
      return label
        ? t('walkthrough.blocked.outputExhausted.description', { model: label })
        : t('walkthrough.blocked.outputExhausted.descriptionUnknownModel');
    }
    if (reason === 'structured-output-unsupported') {
      // Naming the model that was actually tried is the whole point of this
      // screen; the unnamed variant is a defensive fallback, not the norm.
      return label
        ? t('walkthrough.blocked.structuredOutput.description', { model: label })
        : t('walkthrough.blocked.structuredOutput.descriptionUnknownModel');
    }
    const required = Math.ceil((requiredChars ?? 0) / 1000);
    const available = Math.ceil((availableChars ?? 0) / 1000);
    return label
      ? t('walkthrough.blocked.contextTooSmall.description', { model: label, required, available })
      : t('walkthrough.blocked.contextTooSmall.descriptionUnknownModel', { required, available });
  };

  const title = () => {
    if (reason === 'no-model') return t('walkthrough.blocked.noModel.title');
    if (reason === 'empty-diff') return t('walkthrough.blocked.emptyDiff.title');
    if (reason === 'only-generated') return t('walkthrough.blocked.onlyGenerated.title');
    if (reason === 'server-unsupported') return t('walkthrough.blocked.serverUnsupported.title');
    if (reason === 'output-exhausted') return t('walkthrough.blocked.outputExhausted.title');
    if (reason === 'structured-output-unsupported') return t('walkthrough.blocked.structuredOutput.title');
    return t('walkthrough.blocked.contextTooSmall.title');
  };

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <Icon
        name={reason === 'empty-diff' || reason === 'only-generated' ? 'information' : 'error-warning'}
        className="size-6 text-muted-foreground"
      />
      <h3 className="typography-ui-label font-semibold text-foreground">{title()}</h3>
      <p className="typography-meta max-w-md text-muted-foreground">{description()}</p>

      {canChooseModel && (
        <div className="flex flex-col items-center gap-2 pt-2">
          <span className="typography-micro text-muted-foreground">
            {t('walkthrough.blocked.chooseModel')}
          </span>
          <ModelSelector
            providerId={model?.providerID ?? ''}
            modelId={model?.modelID ?? ''}
            onChange={(providerId, modelId) => {
              handleModelChange(providerId, modelId);
            }}
          />
        </div>
      )}

      {/* Retry is the whole remedy once the server is updated, so it stays in
          reach rather than sending the user back through the panel header. */}
      {(reason === 'empty-diff' || reason === 'only-generated' || reason === 'server-unsupported') && (
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          {t('walkthrough.action.refresh')}
        </Button>
      )}
    </div>
  );
};
