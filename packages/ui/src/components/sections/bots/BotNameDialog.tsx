import React from 'react';
import { useI18n } from '@/lib/i18n';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface BotNameDialogProps {
  open: boolean;
  title: string;
  name: string;
  busy?: boolean;
  runtime?: 'pi' | 'agent';
  onRuntimeChange?: (runtime: 'pi' | 'agent') => void;
  error?: string | null;
  onNameChange: (name: string) => void;
  onOpenChange: (open: boolean) => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
}

export const BotNameDialog: React.FC<BotNameDialogProps> = ({
  open,
  title,
  name,
  busy = false,
  runtime = 'pi',
  onRuntimeChange,
  error,
  onNameChange,
  onOpenChange,
  onSubmit,
}) => {
  const { t } = useI18n();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={onSubmit} className="space-y-5">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          <label className="space-y-2">
            <span className="typography-ui-label font-medium">{t('settings.bots.name.label')}</span>
            <Input
              autoFocus
              required
              value={name}
              disabled={busy}
              onChange={(event) => onNameChange(event.target.value)}
              placeholder={t('settings.bots.name.label')}
            />
          </label>
          {onRuntimeChange ? <label className="block space-y-2">
            <span className="typography-ui-label font-medium">Runtime</span>
            <select aria-label="Bot runtime" className="w-full rounded border bg-background p-2 text-sm" value={runtime} disabled={busy}
              onChange={event => onRuntimeChange(event.target.value === 'agent' ? 'agent' : 'pi')}>
              <option value="pi">Pi</option><option value="agent">Agent</option>
            </select>
            <p className="typography-meta text-muted-foreground">The runtime belongs to this new Bot and cannot be changed later.</p>
          </label> : null}
          {error ? <p role="alert" className="typography-meta text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
              {t('dialog.common.actions.close')}
            </Button>
            <Button type="submit" disabled={busy || !name.trim()}>
              {t('settings.bots.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
