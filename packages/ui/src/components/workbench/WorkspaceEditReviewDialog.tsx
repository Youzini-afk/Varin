import React from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useI18n } from '@/lib/i18n';
import {
  getWorkspaceEditReviewSnapshot,
  resolveWorkspaceEditReview,
  subscribeWorkspaceEditReview,
} from '@/lib/language-services/workspace-edit-review';
import { cn } from '@/lib/utils';

type FocusedLines = {
  firstLine: number;
  lines: string[];
  omittedBefore: number;
  omittedAfter: number;
};

const focusedLines = (content: string, other: string): FocusedLines => {
  const lines = content.split('\n');
  const otherLines = other.split('\n');
  let prefix = 0;
  while (prefix < lines.length && prefix < otherLines.length && lines[prefix] === otherLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < lines.length - prefix
    && suffix < otherLines.length - prefix
    && lines[lines.length - 1 - suffix] === otherLines[otherLines.length - 1 - suffix]
  ) suffix += 1;
  const context = 3;
  const start = Math.max(0, prefix - context);
  const changedEnd = Math.max(prefix, lines.length - suffix);
  const end = Math.min(lines.length, changedEnd + context);
  return {
    firstLine: start + 1,
    lines: lines.slice(start, end),
    omittedBefore: start,
    omittedAfter: lines.length - end,
  };
};

const CodePreview: React.FC<{
  content: string;
  other: string;
  full: boolean;
  label: string;
}> = ({ content, other, full, label }) => {
  const preview = full ? null : focusedLines(content, other);
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-md border border-border/70 bg-background">
      <div className="shrink-0 border-b border-border/60 px-3 py-1.5 typography-meta font-medium text-muted-foreground">
        {label}
      </div>
      <div className="min-h-0 flex-1 overflow-auto font-mono typography-code">
        {preview ? (
          <>
            {preview.omittedBefore > 0 ? <div className="px-3 py-1 text-muted-foreground">⋯</div> : null}
            {preview.lines.map((line, index) => (
              <div key={`${preview.firstLine + index}:${line}`} className="flex min-w-max">
                <span className="w-12 shrink-0 select-none border-r border-border/40 px-2 py-0.5 text-right text-muted-foreground/60">
                  {preview.firstLine + index}
                </span>
                <span className="whitespace-pre px-3 py-0.5 text-foreground">{line || ' '}</span>
              </div>
            ))}
            {preview.omittedAfter > 0 ? <div className="px-3 py-1 text-muted-foreground">⋯</div> : null}
          </>
        ) : (
          <pre className="min-w-max whitespace-pre px-3 py-2 text-foreground">{content || ' '}</pre>
        )}
      </div>
    </section>
  );
};

export const WorkspaceEditReviewDialog: React.FC = () => {
  const { t } = useI18n();
  const request = React.useSyncExternalStore(
    subscribeWorkspaceEditReview,
    getWorkspaceEditReviewSnapshot,
    () => null,
  );
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  const [full, setFull] = React.useState(false);
  React.useEffect(() => {
    setSelectedIndex(0);
    setFull(false);
  }, [request?.id]);
  if (!request) return null;
  const selected = request.preview.files[Math.min(selectedIndex, request.preview.files.length - 1)];
  const title = request.kind === 'rename'
    ? t('filesView.workspaceEdit.renameTitle')
    : t('filesView.workspaceEdit.actionTitle');
  return (
    <Dialog open onOpenChange={(open) => { if (!open) resolveWorkspaceEditReview(request.id, false); }}>
      <DialogContent className="flex h-[min(48rem,calc(100dvh-2rem))] max-w-6xl flex-col overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle>{title}</DialogTitle>
          <p className="typography-body text-muted-foreground">
            {request.label || (request.preview.files.length === 1
              ? t('filesView.workspaceEdit.descriptionSingle', { count: request.preview.files.length })
              : t('filesView.workspaceEdit.descriptionMany', { count: request.preview.files.length }))}
          </p>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 gap-3 overflow-hidden">
          <nav className="w-56 shrink-0 overflow-y-auto rounded-md border border-border/70 p-1" aria-label={t('filesView.workspaceEdit.files')}>
            {request.preview.files.map((file, index) => (
              <button
                key={`${index}:${file.identity.workspaceId}:${file.identity.resourceId}`}
                type="button"
                className={cn(
                  'flex w-full flex-col rounded px-2 py-1.5 text-left hover:bg-interactive-hover',
                  index === selectedIndex && 'bg-interactive-selection',
                )}
                onClick={() => setSelectedIndex(index)}
              >
                <span className="truncate typography-ui-label text-foreground">{file.from ? `${file.from.resourceId} → ` : ''}{file.identity.resourceId}</span>
                {file.kind && file.kind !== 'text' ? <span className="typography-meta text-muted-foreground">{t(`filesView.workspaceEdit.operation.${file.kind}`)}</span> : null}
                {file.affectsDraft && file.kind !== 'text' ? <span className="typography-meta text-warning">{t('filesView.workspaceEdit.draftAffected')}</span> : null}
                <span className="typography-meta text-muted-foreground">
                  {file.editCount === 1
                    ? t('filesView.workspaceEdit.editCountSingle', { count: file.editCount })
                    : t('filesView.workspaceEdit.editCountMany', { count: file.editCount })}
                </span>
              </button>
            ))}
          </nav>
          {selected ? (
            <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
              <div className="flex shrink-0 items-center justify-between gap-2">
                <span className="truncate typography-ui-label text-muted-foreground">{selected.identity.resourceId}</span>
                <Button type="button" variant="ghost" size="xs" onClick={() => setFull((value) => !value)}>
                  {full ? t('filesView.workspaceEdit.showFocused') : t('filesView.workspaceEdit.showFull')}
                </Button>
              </div>
              {selected.annotationIds?.map(id => {
                const annotation = request.preview.changeAnnotations?.[id];
                return annotation ? <p key={id} className="typography-meta text-muted-foreground">{annotation.label}{annotation.description ? `: ${annotation.description}` : ''}</p> : null;
              })}
              <div className="flex min-h-0 flex-1 gap-2 max-lg:flex-col">
                <CodePreview content={selected.beforeContent} other={selected.afterContent} full={full} label={t('filesView.workspaceEdit.before')} />
                <CodePreview content={selected.afterContent} other={selected.beforeContent} full={full} label={t('filesView.workspaceEdit.after')} />
              </div>
            </div>
          ) : (
            <div className="flex flex-1 items-center justify-center text-muted-foreground">
              {t('filesView.workspaceEdit.noChanges')}
            </div>
          )}
        </div>
        <DialogFooter className="shrink-0">
          <Button type="button" variant="outline" onClick={() => resolveWorkspaceEditReview(request.id, false)}>
            {t('settings.common.actions.cancel')}
          </Button>
          <Button type="button" onClick={() => resolveWorkspaceEditReview(request.id, true)}>
            {t('filesView.workspaceEdit.apply')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
