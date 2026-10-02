import React from 'react';
import type { PiAgentActionDescriptor, PiAgentDescriptor } from '@varin/protocol';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useI18n } from '@/lib/i18n';

type ActionScope = 'user' | 'project';

interface AgentProviderActionDialogProps {
  action: PiAgentActionDescriptor | null;
  agent: PiAgentDescriptor | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (scope?: ActionScope) => Promise<boolean>;
  open: boolean;
  projectTrusted: boolean;
  submitting: boolean;
  error?: string | null;
}

export const AgentProviderActionDialog: React.FC<AgentProviderActionDialogProps> = ({
  action,
  agent,
  onOpenChange,
  onSubmit,
  open,
  projectTrusted,
  submitting,
  error,
}) => {
  const { t } = useI18n();
  const inferredScope = agent?.source.scope === 'user' || agent?.source.scope === 'project'
    ? agent.source.scope
    : undefined;
  const [scope, setScope] = React.useState<ActionScope>(inferredScope ?? 'user');
  const chooseScope = action?.requiresScope === true && inferredScope === undefined;

  React.useEffect(() => {
    if (open) setScope(inferredScope ?? 'user');
  }, [inferredScope, open]);

  if (!action || !agent) return null;

  const effectiveScope = chooseScope ? scope : inferredScope;
  const projectBlocked = effectiveScope === 'project' && !projectTrusted;
  const descriptionKey = action.destructive
    ? 'settings.varin.agents.actionDialog.destructiveDescription'
    : 'settings.varin.agents.actionDialog.scopeDescription';

  return (
    <Dialog open={open} onOpenChange={(next) => !submitting && onOpenChange(next)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t('settings.varin.agents.actionDialog.title', {
              action: action.label,
              agent: agent.name,
            })}
          </DialogTitle>
          <DialogDescription>
            {t(descriptionKey, { action: action.label, agent: agent.name })}
          </DialogDescription>
        </DialogHeader>

        {chooseScope ? (
          <div className="space-y-1.5">
            <label className="typography-settings-field-label text-foreground" htmlFor="agent-action-scope">
              {t('settings.varin.agents.definition.field.saveLocation')}
            </label>
            <Select value={scope} onValueChange={setScope} disabled={submitting}>
              <SelectTrigger id="agent-action-scope" size="settings" className="w-full">
                <SelectValue>
                  {scope === 'project'
                    ? t('settings.varin.agents.scope.project')
                    : t('settings.varin.agents.scope.user')}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="user">{t('settings.varin.agents.scope.user')}</SelectItem>
                <SelectItem value="project" disabled={!projectTrusted}>
                  {t('settings.varin.agents.scope.project')}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        ) : null}

        {projectBlocked ? (
          <p className="typography-meta text-[var(--status-warning)]">
            {t('settings.varin.recovery.pluginSettings.projectUntrusted')}
          </p>
        ) : null}

        {error && <p role="alert" className="typography-meta text-destructive">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={submitting} onClick={() => onOpenChange(false)}>
            {t('settings.common.actions.cancel')}
          </Button>
          <Button
            type="button"
            variant={action.destructive ? 'destructive' : 'default'}
            disabled={submitting || projectBlocked}
            onClick={() => void onSubmit(effectiveScope).then((success) => {
              if (success) onOpenChange(false);
            })}
          >
            {submitting ? <Icon name="loader-4" className="size-4 animate-spin" /> : null}
            {action.label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
