import React from 'react';
import type { CompactionTrace, JsonValue } from '@varin/protocol';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useI18n } from '@/lib/i18n';

const resultText = (value: JsonValue | undefined): string => {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value) && Array.isArray(value.content)) {
    const text = value.content.flatMap((part) => (
      part && typeof part === 'object' && !Array.isArray(part) && typeof part.text === 'string'
        ? [part.text]
        : []
    )).join('\n');
    if (text) return text;
  }
  return JSON.stringify(value, null, 2);
};

export const PiCompactionTraceDialog: React.FC<{
  error?: string;
  onOpenChange(open: boolean): void;
  open: boolean;
  status: 'requested' | 'running' | 'retrying' | 'ready' | 'committed' | 'failed';
  trace: CompactionTrace | null;
  partial?: { text: string; thinking: string };
  retry?: { attempt: number; maxAttempts: number; reason: string };
}> = ({ error, onOpenChange, open, partial, retry, status, trace }) => {
  const { t } = useI18n();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[80dvh] max-w-[90vw] flex-col">
        <DialogHeader>
          <DialogTitle>/compact</DialogTitle>
          <DialogDescription>{t('harness.threads.transcriptReadOnly')}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-3 overflow-auto pr-2">
          {trace?.entries.map((entry, index) => (
            <article key={`${trace.taskId}:${index}`} className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
              <div className="mb-1 typography-meta font-medium text-muted-foreground">
                {entry.kind === 'assistant' ? 'Agent' : entry.toolName ?? 'Tool'}
              </div>
              {entry.thinking ? (
                <details className="mb-2">
                  <summary className="cursor-pointer typography-meta text-muted-foreground">{t('chat.compaction.thinking')}</summary>
                  <MarkdownRenderer content={entry.thinking} messageId={`${trace.taskId}:${index}:thinking`} />
                </details>
              ) : null}
              {entry.text ? <MarkdownRenderer content={entry.text} messageId={`${trace.taskId}:${index}:text`} /> : null}
              {entry.kind === 'tool-call' ? <pre className="whitespace-pre-wrap break-words typography-meta">{resultText(entry.args)}</pre> : null}
              {entry.kind === 'tool-result' ? <pre className="whitespace-pre-wrap break-words typography-meta">{resultText(entry.result)}</pre> : null}
            </article>
          ))}
          {partial?.text || partial?.thinking ? (
            <article className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
              <div className="mb-1 typography-meta font-medium text-muted-foreground">Agent</div>
              {partial.thinking ? <MarkdownRenderer content={partial.thinking} messageId={`${trace?.taskId ?? 'active'}:thinking`} /> : null}
              {partial.text ? <MarkdownRenderer content={partial.text} messageId={`${trace?.taskId ?? 'active'}:text`} /> : null}
            </article>
          ) : null}
          {status === 'requested' || status === 'running' ? <p role="status" className="typography-meta text-muted-foreground">{t('chat.compaction.inProgress')}</p> : null}
          {status === 'retrying' ? <p role="status" className="typography-meta text-muted-foreground">
            {t('chat.compaction.retrying')}{retry ? ` (${retry.attempt}/${retry.maxAttempts})` : ''}
          </p> : null}
          {status === 'ready' ? <p role="status" className="typography-meta text-muted-foreground">{t('chat.compaction.ready')}</p> : null}
          {status === 'failed' ? <p role="alert" className="typography-meta text-[var(--status-error)]">{error ?? t('chat.chatInput.toast.compactFailed')}</p> : null}
        </div>
      </DialogContent>
    </Dialog>
  );
};
