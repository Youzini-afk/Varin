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
  submitLabel?: string;
  name: string;
  busy?: boolean;
  error?: string | null;
  onNameChange: (name: string) => void;
  onOpenChange: (open: boolean) => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
}

export const BotNameDialog: React.FC<BotNameDialogProps> = ({
  open,
  title,
  submitLabel,
  name,
  busy = false,
  error,
  onNameChange,
  onOpenChange,
  onSubmit,
}) => {
  const { t } = useI18n();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <form onSubmit={onSubmit} className="flex flex-col gap-6">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          <label className="flex flex-col gap-2">
            <span className="typography-ui-label font-medium">{t('settings.bots.name.label')}</span>
            <Input
              autoFocus
              required
              value={name}
              disabled={busy}
              onChange={(event) => onNameChange(event.target.value)}
              placeholder={t('settings.bots.name.placeholder')}
            />
          </label>
          {error ? <p role="alert" className="typography-meta text-destructive">{error}</p> : null}
          <DialogFooter className="gap-2">
            <Button type="button" variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
              {t('settings.common.actions.cancel')}
            </Button>
            <Button type="submit" className="min-w-20" disabled={busy || !name.trim()}>
              {submitLabel ?? t('settings.bots.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
