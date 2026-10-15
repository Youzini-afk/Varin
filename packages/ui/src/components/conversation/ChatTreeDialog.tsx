import React from 'react';
import type { ChatSessionMessageEntry } from './types';
import type { SessionTreeResult, SessionTreeNode } from './chatSessionTree';
import type { ThreadsAPI, ThreadIdentity, ThreadHistoryItem, ThreadSnapshot } from '@varin/application-client';
import { HistoryPresentation } from './historyPresentation';
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
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { projectChatSessionTree } from './chatSessionTree';

interface ChatTreeDialogProps {
  busy?: boolean;
  initialQuery?: string;
  onFork(entry: ChatSessionMessageEntry): Promise<void> | void;
  onOpenChange(open: boolean): void;
  onRecover(entry: ChatSessionMessageEntry): Promise<void> | void;
  open: boolean;
  identity: ThreadIdentity;
  api: ThreadsAPI;
  recoverDisabled?: boolean;
}

const normalizedSearchText = (value: string): string => value.toLocaleLowerCase().trim();

export const ChatTreeDialog: React.FC<ChatTreeDialogProps> = ({
  busy = false,
  initialQuery = '',
  onFork,
  onOpenChange,
  onRecover,
  open,
  identity, api, recoverDisabled = false,
}) => {
  const { t } = useI18n();
  const [history, setHistory] = React.useState<ThreadHistoryItem[]>([]);
  const [snapshot, setSnapshot] = React.useState<ThreadSnapshot>();
  const [previous, setPrevious] = React.useState<string | null>(null);
  const [head, setHead] = React.useState<string | null>(null);
  const [tree, setTree] = React.useState<SessionTreeResult | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState(initialQuery);
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  const itemRefs = React.useRef<(HTMLButtonElement | null)[]>([]);
  const generationRef = React.useRef(0);

  const load = React.useCallback(async () => {
    const generation = ++generationRef.current;
    setLoading(true);
    setError(null);
    setTree(null);
    try {
      const result = await api.snapshot(identity);
      if (generation !== generationRef.current) return;
      setHistory(result.history); setSnapshot(result); setPrevious(result.historyPage.previous); setHead(result.historyPage.head);
    } catch (loadError) {
      if (generation !== generationRef.current) return;
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  }, [api, identity]);

  React.useEffect(() => {
    if (!snapshot) return;
    const entries = new HistoryPresentation(identity.threadId).project(history, snapshot).entries;
    const nodes = new Map(entries.map(entry => [entry.id, { entry, children: [] } as SessionTreeNode]));
    const roots: SessionTreeNode[] = [];
    for (const node of nodes.values()) {
      const parent = node.entry.parentId ? nodes.get(node.entry.parentId) : undefined;
      if (parent) parent.children.push(node); else roots.push(node);
    }
    setTree({ tree: roots, leafId: head });
  }, [history, snapshot, identity, head]);
  const earlier = async () => {
    if (!head || !previous || loading) return;
    const generation = generationRef.current; setLoading(true); setError(null);
    try { const page = await api.historyPage(identity, { headId: head, beforeId: previous });
      if (generation === generationRef.current) { setHistory(items => [...page.items, ...items]); setPrevious(page.previous); }
    } catch (error) { if (generation === generationRef.current) setError(String(error)); }
    finally { if (generation === generationRef.current) setLoading(false); }
  };
  React.useEffect(() => {
    if (!open) {
      generationRef.current += 1;
      return;
    }
    setQuery(initialQuery);
    void load();
  }, [initialQuery, load, open]);

  const items = React.useMemo(() => tree ? projectChatSessionTree(tree) : [], [tree]);
  const filteredItems = React.useMemo(() => {
    const search = normalizedSearchText(query);
    if (!search) return items;
    return items.filter((item) => {
      const role = item.entry.message.role === 'user' ? 'user you' : 'assistant varin';
      return normalizedSearchText([
        item.text,
        item.label ?? '',
        role,
      ].join('\n')).includes(search);
    });
  }, [items, query]);

  React.useEffect(() => {
    const currentIndex = filteredItems.findIndex((item) => item.current);
    setSelectedIndex(currentIndex >= 0 ? currentIndex : Math.max(0, filteredItems.length - 1));
    itemRefs.current = itemRefs.current.slice(0, filteredItems.length);
  }, [filteredItems]);

  React.useLayoutEffect(() => {
    itemRefs.current[selectedIndex]?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const selected = filteredItems[selectedIndex];
  const moveSelection = React.useCallback((offset: number) => {
    setSelectedIndex((current) => {
      if (filteredItems.length === 0) return 0;
      return (current + offset + filteredItems.length) % filteredItems.length;
    });
  }, [filteredItems.length]);

  const recoverSelected = React.useCallback(() => {
    if (!selected || busy || recoverDisabled) return;
    onOpenChange(false);
    void onRecover(selected.entry);
  }, [busy, recoverDisabled, onOpenChange, onRecover, selected]);

  const forkSelected = React.useCallback(() => {
    if (!selected || busy) return;
    onOpenChange(false);
    void onFork(selected.entry);
  }, [busy, onFork, onOpenChange, selected]);

  const handleNavigationKey = React.useCallback((event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveSelection(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveSelection(-1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      recoverSelected();
    }
  }, [moveSelection, recoverSelected]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[78vh] max-w-2xl flex-col gap-4">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon name="git-branch" className="size-5" />
            {t('chat.timeline.title')}
          </DialogTitle>
          <DialogDescription>{t('chat.timeline.description')}</DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Icon
              name="search"
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              autoFocus
              className="pl-9"
              placeholder={t('chat.timeline.searchPlaceholder')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={handleNavigationKey}
            />
          </div>
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={() => void load()}
            disabled={loading}
            aria-label={t('chat.timeline.refresh')}
          >
            <Icon name="refresh" className={cn('size-4', loading && 'animate-spin')} />
          </Button>
        </div>

        <div
          className="min-h-48 flex-1 overflow-y-auto rounded-xl border border-border/70 bg-muted/10 p-1.5"
          role="listbox"
          aria-label={t('chat.timeline.title')}
          onKeyDown={handleNavigationKey}
        >
          {loading && !tree ? (
            <div className="flex min-h-48 items-center justify-center gap-2 text-muted-foreground" aria-busy="true">
              <Icon name="loader-4" className="size-4 animate-spin" />
              <span className="typography-ui-label">{t('common.loading')}</span>
            </div>
          ) : error ? (
            <div className="flex min-h-48 flex-col items-center justify-center gap-3 px-6 text-center">
              <p className="typography-ui-label text-[var(--status-error)]">
                {t('chat.timeline.loadFailed')}
              </p>
              <p className="max-w-lg typography-meta text-muted-foreground">{error}</p>
              <Button type="button" variant="outline" size="sm" onClick={() => void load()}>
                {t('chat.timeline.retry')}
              </Button>
            </div>
          ) : filteredItems.length === 0 ? (
            <div className="flex min-h-48 items-center justify-center px-6 text-center typography-ui-label text-muted-foreground">
              {query.trim() ? t('chat.timeline.empty.search') : t('chat.timeline.empty.session')}
            </div>
          ) : (
            filteredItems.map((item, index) => {
              const selectedRow = index === selectedIndex;
              const user = item.entry.message.role === 'user';
              return (
                <button
                  key={item.entry.id}
                  ref={(element) => { itemRefs.current[index] = element; }}
                  type="button"
                  role="option"
                  aria-selected={selectedRow}
                  className={cn(
                    'group flex w-full items-start gap-2 rounded-lg py-2 pr-3 text-left transition-colors',
                    selectedRow ? 'bg-interactive-selection' : 'hover:bg-interactive-hover/50',
                    !item.active && 'text-muted-foreground',
                  )}
                  style={{ paddingLeft: `${12 + item.branchDepth * 18}px` }}
                  onClick={() => setSelectedIndex(index)}
                  onDoubleClick={() => {
                    if (busy || recoverDisabled) return;
                    onOpenChange(false);
                    void onRecover(item.entry);
                  }}
                  onMouseMove={() => setSelectedIndex(index)}
                >
                  <span className={cn(
                    'mt-1.5 size-2 shrink-0 rounded-full border',
                    item.active
                      ? 'border-primary bg-primary'
                      : 'border-muted-foreground/50 bg-background',
                  )} />
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className={cn(
                        'typography-meta font-medium',
                        user ? 'text-foreground' : 'text-primary',
                      )}>
                        {user
                          ? t('contextSidebar.breakdown.user')
                          : t('contextSidebar.breakdown.assistant')}
                      </span>
                      {item.label ? (
                        <span className="truncate rounded border border-border/70 px-1.5 py-0.5 typography-micro text-muted-foreground">
                          {item.label}
                        </span>
                      ) : null}
                      {item.current ? (
                        <span className="rounded bg-primary/10 px-1.5 py-0.5 typography-micro text-primary">
                          {t('chat.modelControls.current')}
                        </span>
                      ) : null}

                    </span>
                    <span className="mt-0.5 block truncate typography-ui-label">
                      {item.text || t('chat.timeline.noTextContent')}
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </div>

        {previous && <Button type="button" variant="ghost" disabled={loading} onClick={() => void earlier()}>{t('chat.history.loadEarlier')}</Button>}
        <DialogFooter className="gap-2 sm:justify-between">
          <Button
            type="button"
            variant="outline"
            onClick={forkSelected}
            disabled={!selected || busy}
          >
            <Icon name="git-branch" className="size-4" />
            {t('chat.timeline.actions.forkFromHere')}
          </Button>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('sessions.sidebar.dialogs.cancel')}
            </Button>
            <Button type="button" onClick={recoverSelected} disabled={!selected || busy || recoverDisabled}>
              <Icon name="arrow-go-back" className="size-4" />
              {t('chat.timeline.actions.revertFromHere')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
