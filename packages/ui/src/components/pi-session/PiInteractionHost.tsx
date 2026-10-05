import React from 'react';
import type { JsonValue } from '@varin/protocol';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { useI18n } from '@/lib/i18n';
import { PiQuestionPopup } from './PiQuestionPopup';
import {
  piDialogResponseKey,
  piTrustResponseKey,
  usePiInteractionStore,
} from '@/stores/usePiInteractionStore';

const payloadRecord = (value: JsonValue): Record<string, JsonValue> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : {}
);

const stringValue = (record: Record<string, JsonValue>, key: string): string => (
  typeof record[key] === 'string' ? record[key] as string : ''
);

const stringList = (record: Record<string, JsonValue>, key: string): string[] => {
  const value = record[key];
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value as string[]
    : [];
};

export const PiInteractionHost: React.FC = () => {
  const { t } = useI18n();
  const trust = usePiInteractionStore((state) => state.trustRequests[0]);
  const dialog = usePiInteractionStore((state) => state.dialogs.find(dialog => dialog.method !== 'question'));
  const notice = usePiInteractionStore((state) => state.notices[0]);
  const lastError = usePiInteractionStore((state) => state.lastError);
  const responding = usePiInteractionStore((state) => state.responding);
  const connect = usePiInteractionStore((state) => state.connect);
  const dismissNotice = usePiInteractionStore((state) => state.dismissNotice);
  const respondDialog = usePiInteractionStore((state) => state.respondDialog);
  const respondTrust = usePiInteractionStore((state) => state.respondTrust);
  const [rememberTrust, setRememberTrust] = React.useState(false);
  const [dialogValue, setDialogValue] = React.useState('');
  const lastShownNotice = React.useRef<string | null>(null);

  React.useLayoutEffect(() => {
    void connect().catch((error) => {
      console.error('Failed to subscribe to Pi interactions:', error);
    });
  }, [connect]);

  React.useEffect(() => {
    setRememberTrust(false);
  }, [trust?.id]);

  React.useEffect(() => {
    if (!dialog) {
      setDialogValue('');
      return;
    }
    const payload = payloadRecord(dialog.payload);
    setDialogValue(dialog.method === 'editor' ? stringValue(payload, 'prefill') : '');
  }, [dialog]);

  React.useEffect(() => {
    if (!notice || lastShownNotice.current === notice.id) return;
    lastShownNotice.current = notice.id;
    toast[notice.type](notice.message);
    dismissNotice(notice.id);
  }, [dismissNotice, notice]);

  const answerTrust = React.useCallback(async (trusted: boolean) => {
    if (!trust) return;
    try {
      await respondTrust(trust.id, trusted, rememberTrust);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }, [rememberTrust, respondTrust, trust]);

  const answerDialog = React.useCallback(async (
    value?: JsonValue,
    cancelled = false,
  ) => {
    if (!dialog) return;
    try {
      await respondDialog(dialog.id, value, cancelled);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }, [dialog, respondDialog]);

  const trustBusy = trust ? responding[piTrustResponseKey(trust.id)] === true : false;
  const dialogBusy = dialog ? responding[piDialogResponseKey(dialog.id)] === true : false;
  const dialogPayload = dialog ? payloadRecord(dialog.payload) : {};
  const dialogTitle = stringValue(dialogPayload, 'title') || t('pi.interaction.extensionFallback');
  const [dialogHeading, ...dialogDetailLines] = dialogTitle.split('\n');
  const dialogDetails = dialogDetailLines.join('\n').trim();

  return (
    <>
      <PiQuestionPopup />
      <Dialog
        open={Boolean(trust)}
        onOpenChange={(open) => {
          if (!open && trust && !trustBusy) void answerTrust(false);
        }}
      >
        <DialogContent showCloseButton={false} className="max-w-lg gap-5">
          <DialogHeader>
            <DialogTitle>{t('pi.interaction.trust.title')}</DialogTitle>
            <DialogDescription>
              {t('pi.interaction.trust.description')}
            </DialogDescription>
          </DialogHeader>
          {trust && (
            <div className="space-y-3">
              <div className="rounded-lg border border-border/70 bg-muted/20 px-3 py-2">
                <p className="typography-micro font-medium uppercase tracking-wide text-muted-foreground">
                  {t('pi.interaction.trust.workspace')}
                </p>
                <p className="mt-1 break-all font-mono typography-ui-label text-foreground">{trust.cwd}</p>
              </div>
              <label className="flex cursor-pointer items-center gap-2 typography-ui-label text-foreground">
                <input
                  type="checkbox"
                  checked={rememberTrust}
                  onChange={(event) => setRememberTrust(event.target.checked)}
                  disabled={trustBusy}
                  className="size-4 accent-[var(--primary-base)]"
                />
                {t('pi.interaction.trust.remember')}
              </label>
              {lastError && (
                <p className="typography-meta text-[var(--status-error)]">{lastError}</p>
              )}
            </div>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={trustBusy}
              onClick={() => void answerTrust(false)}
            >
              {t('chat.permissionToast.actions.deny')}
            </Button>
            <Button
              type="button"
              disabled={trustBusy}
              onClick={() => void answerTrust(true)}
            >
              {t('chat.modelControls.permissionLabel.allow')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!trust && Boolean(dialog)}
        onOpenChange={(open) => {
          if (!open && dialog && !dialogBusy) void answerDialog(undefined, true);
        }}
      >
        <DialogContent
          showCloseButton={false}
          className={dialog?.method === 'custom' ? 'max-w-4xl gap-5' : 'max-w-lg gap-5'}
        >
          <DialogHeader>
            <DialogTitle>{dialogHeading}</DialogTitle>
            {dialog?.method === 'confirm' && (
              <DialogDescription className="whitespace-pre-wrap">
                {stringValue(dialogPayload, 'message')}
              </DialogDescription>
            )}
            {dialog?.method !== 'confirm' && dialogDetails ? (
              <DialogDescription className="max-h-[40vh] overflow-auto whitespace-pre-wrap font-mono typography-meta text-left">
                {dialogDetails}
              </DialogDescription>
            ) : null}
          </DialogHeader>

          {dialog?.method === 'select' && (
            <div className="grid max-h-[50vh] gap-2 overflow-y-auto">
              {stringList(dialogPayload, 'options').map((option, index) => (
                <Button
                  key={`${index}:${option}`}
                  type="button"
                  variant="outline"
                  disabled={dialogBusy}
                  className="h-auto min-h-9 justify-start whitespace-normal py-2 text-left"
                  onClick={() => void answerDialog(option)}
                >
                  {option}
                </Button>
              ))}
            </div>
          )}

          {dialog?.method === 'input' && (
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                if (!dialogBusy) void answerDialog(dialogValue);
              }}
            >
              <Input
                autoFocus
                value={dialogValue}
                placeholder={stringValue(dialogPayload, 'placeholder')}
                disabled={dialogBusy}
                onChange={(event) => setDialogValue(event.target.value)}
              />
              <DialogFooter>
                <Button type="button" variant="outline" disabled={dialogBusy} onClick={() => void answerDialog(undefined, true)}>
                  {t('sessions.sidebar.dialogs.cancel')}
                </Button>
                <Button type="submit" disabled={dialogBusy}>
                  {t('gitView.history.actions.confirmButton')}
                </Button>
              </DialogFooter>
            </form>
          )}

          {dialog?.method === 'editor' && (
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                if (!dialogBusy) void answerDialog(dialogValue);
              }}
            >
              <Textarea
                autoFocus
                value={dialogValue}
                disabled={dialogBusy}
                className="min-h-48"
                onChange={(event) => setDialogValue(event.target.value)}
              />
              <DialogFooter>
                <Button type="button" variant="outline" disabled={dialogBusy} onClick={() => void answerDialog(undefined, true)}>
                  {t('sessions.sidebar.dialogs.cancel')}
                </Button>
                <Button type="submit" disabled={dialogBusy}>
                  {t('gitView.history.actions.confirmButton')}
                </Button>
              </DialogFooter>
            </form>
          )}

          {dialog?.method === 'custom' && (
            <div className="space-y-4">
              <pre className="max-h-[65vh] overflow-auto whitespace-pre font-mono typography-meta text-foreground">
                {stringList(dialogPayload, 'lines').join('\n')}
              </pre>
              <DialogFooter>
                <Button type="button" disabled={dialogBusy} onClick={() => void answerDialog()}>
                  {t('gitView.history.actions.confirmButton')}
                </Button>
              </DialogFooter>
            </div>
          )}

          {dialog?.method === 'confirm' && (
            <DialogFooter>
              <Button type="button" variant="outline" disabled={dialogBusy} onClick={() => void answerDialog(false)}>
                {t('sessions.sidebar.dialogs.cancel')}
              </Button>
              <Button type="button" disabled={dialogBusy} onClick={() => void answerDialog(true)}>
                {t('gitView.history.actions.confirmButton')}
              </Button>
            </DialogFooter>
          )}

          {dialog?.method === 'select' && (
            <DialogFooter>
              <Button type="button" variant="outline" disabled={dialogBusy} onClick={() => void answerDialog(undefined, true)}>
                {t('sessions.sidebar.dialogs.cancel')}
              </Button>
            </DialogFooter>
          )}

          {dialog && lastError && (
            <p className="typography-meta text-[var(--status-error)]">{lastError}</p>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
};
