import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { presentToolResult } from './toolResultPresentation';
import type { ChatToolResultMessage } from './types';

export function ChatToolResultPreview({ result }: { result: ChatToolResultMessage }) {
  const { t } = useI18n();
  const preview = presentToolResult(result);
  if (!preview) return null;
  if (preview.kind === 'diagnostic') return <div className={cn('space-y-1 typography-meta', result.isError || result.status === 'error' ? 'text-[var(--status-error)]' : 'text-muted-foreground')}>
    <p className="font-mono typography-micro">{preview.code}</p>
    <p className="whitespace-pre-wrap break-words">{preview.message}</p>
  </div>;
  const range = preview.kind === 'text' || preview.kind === 'bytes' ? preview : undefined;
  return <section aria-label={t('chat.toolResult.fileContents', { path: preview.path })} className="overflow-hidden rounded-md border border-border/60 bg-background/70">
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/50 px-3 py-2 typography-micro text-muted-foreground">
      <span className="min-w-0 flex-1 truncate font-mono" title={preview.path}>{preview.path}</span>
      {range ? <span>{t('chat.toolResult.byteRange', { bytes: range.nextOffset - range.offset, total: range.byteLength, offset: range.offset })}</span> : null}
      {range && (range.offset > 0 || !range.eof) ? <span>{t('chat.toolResult.partial')}</span> : null}
    </div>
    {preview.kind === 'text' && preview.text.length > 0 ? <pre tabIndex={0} className="max-h-80 overflow-auto p-3 font-mono typography-micro text-foreground"><code>{preview.text}</code></pre>
      : <p className="whitespace-pre-wrap break-words px-3 py-2 typography-meta text-muted-foreground">
        {preview.kind === 'text' ? t(preview.byteLength === 0 ? 'chat.toolResult.emptyFile' : 'chat.toolResult.emptyRange')
          : preview.kind === 'symlink' ? t('chat.toolResult.symlink', { target: preview.target })
          : t(`chat.toolResult.${preview.kind}`)}
      </p>}
  </section>;
}
