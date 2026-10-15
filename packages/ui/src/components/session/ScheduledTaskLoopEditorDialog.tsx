import * as React from 'react';
import { Button } from '@/components/ui/button';
import { CodeMirrorEditor } from '@/components/ui/CodeMirrorEditor';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { createScheduledTasksHttpAPI, type ScheduledTask, type ScheduledTaskLoopDocument } from '@varin/application-client';
const schedules = createScheduledTasksHttpAPI();

export function ScheduledTaskLoopEditorDialog({
  open,
  projectID,
  task,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  projectID: string;
  task: ScheduledTask | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [document, setDocument] = React.useState<ScheduledTaskLoopDocument | null>(null);
  const [content, setContent] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const openRef = React.useRef(open);

  React.useEffect(() => {
    openRef.current = open;
  }, [open]);

  React.useEffect(() => {
    if (!open || !projectID || !task?.loopFile) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    void schedules.readLoop(projectID, task.id)
      .then((next) => {
        if (cancelled) return;
        setDocument(next);
        setContent(next.content);
      })
      .catch((error) => {
        if (cancelled) return;
        setDocument(null);
        setLoadError(error instanceof Error ? error.message : t('sessions.scheduledTasks.dialog.toast.loadFailed'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, projectID, task?.id, task?.loopFile, t]);

  const dirty = Boolean(document && content !== document.content);

  const requestClose = React.useCallback(() => {
    if (dirty && !window.confirm(t('sessions.scheduledTasks.loopEditor.confirmDiscard'))) return;
    onOpenChange(false);
  }, [dirty, onOpenChange, t]);

  const handleSave = React.useCallback(async () => {
    if (!document || !task) return;
    setSaving(true);
    try {
      const { document: next } = await schedules.updateLoop(projectID, task.id, content, document.revision);
      setDocument(next);
      setContent(next.content);
      await onSaved();
      if (!openRef.current) return;
      onOpenChange(false);
      toast.success(t('sessions.scheduledTasks.dialog.toast.saved'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('sessions.scheduledTasks.editor.toast.saveFailed'));
    } finally {
      setSaving(false);
    }
  }, [content, document, onOpenChange, onSaved, projectID, t, task]);

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : requestClose())}>
      <DialogContent className="flex h-[min(760px,88vh)] w-[min(900px,92vw)] max-w-none flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b border-border/50 px-5 py-4">
          <DialogTitle>{t('sessions.scheduledTasks.loopEditor.title')}</DialogTitle>
          <DialogDescription className="truncate" title={task?.loopFile}>
            {task?.loopFile || t('sessions.scheduledTasks.loopEditor.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1">
          {loading ? (
            <div className="flex h-full items-center justify-center gap-2 text-muted-foreground">
              <Icon name="loader-4" className="h-4 w-4 animate-spin" />
              {t('sessions.scheduledTasks.dialog.loading')}
            </div>
          ) : loadError ? (
            <div className="m-5 rounded-md border border-destructive/40 bg-destructive/5 p-3 typography-meta text-destructive">
              {loadError}
            </div>
          ) : (
            <CodeMirrorEditor
              value={content}
              onChange={setContent}
              className="h-full"
              enableSearch
            />
          )}
        </div>

        <DialogFooter className="shrink-0 border-t border-border/50 px-5 py-3">
          <Button variant="ghost" onClick={requestClose} disabled={saving}>
            {t('sessions.scheduledTasks.editor.actions.cancel')}
          </Button>
          <Button onClick={() => void handleSave()} disabled={!dirty || saving || loading || Boolean(loadError)}>
            {saving
              ? t('sessions.scheduledTasks.editor.actions.saving')
              : t('sessions.scheduledTasks.editor.actions.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
