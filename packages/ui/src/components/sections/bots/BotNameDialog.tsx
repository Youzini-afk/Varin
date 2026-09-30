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
  onNameChange: (name: string) => void;
  onOpenChange: (open: boolean) => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
}

export const BotNameDialog: React.FC<BotNameDialogProps> = ({
  open,
  title,
  name,
  busy = false,
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
