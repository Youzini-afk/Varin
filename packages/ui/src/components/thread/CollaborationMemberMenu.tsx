import React from 'react';
import { DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';

/** Fill the visible menu, then continue paging as the user approaches its end. */
export function CollaborationMemberMenu({ open, count, more, loading = false, error, loadMore, children, ...position }: {
  open: boolean;
  count: number;
  more: boolean;
  loading?: boolean;
  error?: string;
  loadMore(): void;
  children: React.ReactNode;
  align?: 'start' | 'end';
  side?: 'top' | 'bottom';
}) {
  const { t } = useI18n();
  const [content, setContent] = React.useState<HTMLDivElement | null>(null);
  const continueReading = React.useCallback(() => {
    const node = content;
    if (!open || !more || loading || error || !node) return;
    if (!count || (node.clientHeight > 0 && node.scrollHeight - node.scrollTop <= node.clientHeight * 1.5)) loadMore();
  }, [open, more, loading, error, count, loadMore, content]);
  React.useEffect(() => {
    if (!open) return;
    continueReading();
    if (!content || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(continueReading);
    observer.observe(content);
    return () => observer.disconnect();
  }, [open, continueReading, content]);
  return <DropdownMenuContent
    {...position}
    ref={setContent}
    className="w-72 max-w-[calc(100vw-2rem)] overflow-y-auto overscroll-contain"
    style={{ maxHeight: 'min(22rem, var(--available-height, 70vh))', scrollbarGutter: 'stable' }}
    aria-busy={loading}
    onScroll={continueReading}
  >
    {children}
    {error ? <>
      <p role="alert" className="px-2 py-1.5 typography-micro text-destructive break-words">{error}</p>
      <DropdownMenuItem closeOnClick={false} onClick={loadMore}><Icon name="refresh" className="size-3.5" />{t('common.retry')}</DropdownMenuItem>
    </> : loading || (more && !count) ? (
      <div role="status" className="flex items-center gap-2 px-2 py-2 typography-micro text-muted-foreground">
        <Icon name="loader-4" className="size-3.5 animate-spin" />{t('common.loading')}
      </div>
    ) : !count && !more ? (
      <p className="px-2 py-3 typography-meta text-muted-foreground">{t('collaboration.noRecipients')}</p>
    ) : null}
  </DropdownMenuContent>;
}
