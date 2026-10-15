import React from 'react';
import {
  RiArrowGoBackLine,
  RiArrowGoForwardLine,
  RiCommandLine,
  RiFileLine,
  RiGitBranchLine,
  RiRefreshLine,
  RiScissorsLine,
  RiSearchEyeLine,
  RiTerminalBoxLine,
  RiTimeLine,
} from '@remixicon/react';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { commandMatchesSearch } from './commandAutocompleteItems';
import { useComposerResources } from './useComposerResources';
import { useMobileAutocompleteMaxHeight } from './useMobileAutocompleteMaxHeight';

type CommandSource = 'extension' | 'varin' | 'prompt' | 'skill' | 'unknown';

export interface CommandInfo {
  description?: string;
  id: string;
  isSkill?: boolean;
  name: string;
  source: CommandSource;
}

export interface CommandAutocompleteHandle {
  handleKeyDown(key: string): void;
}

const BASE_BADGE_CLASS = 'text-[10px] leading-none uppercase font-bold tracking-tight px-1.5 py-1 rounded border flex-shrink-0';
const TYPE_BADGE_CLASS = cn(
  BASE_BADGE_CLASS,
  'bg-[color-mix(in_srgb,var(--primary-base)_12%,transparent)] text-[color-mix(in_srgb,var(--primary-base)_70%,transparent)] border-[color-mix(in_srgb,var(--primary-base)_24%,transparent)]',
);
const SOURCE_BADGE_CLASS = cn(
  BASE_BADGE_CLASS,
  'bg-[var(--surface-muted)] text-muted-foreground border-[var(--interactive-border)]/60',
);

interface CommandAutocompleteProps {
  additionalCommands?: readonly CommandInfo[];
  cwd?: string | null;
  onClose(): void;
  onCommandSelect(command: CommandInfo): void;
  searchQuery: string;
  sessionId?: string | null;
  style?: React.CSSProperties;
}

const normalizeSource = (source: string | undefined): CommandSource => {
  if (source === 'extension' || source === 'varin' || source === 'prompt' || source === 'skill') return source;
  return 'unknown';
};

export const CommandAutocomplete = React.forwardRef<CommandAutocompleteHandle, CommandAutocompleteProps>(({
  additionalCommands = [],
  cwd,
  onCommandSelect,
  onClose,
  searchQuery,
  sessionId,
  style,
}, ref) => {
  const { t } = useI18n();
  const isMobile = useUIStore((state) => state.isMobile);
  const { commands: resourceCommands, loading, error, refresh } = useComposerResources({
    cwd,
    refreshOnMount: true,
    sessionId,
  });
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  const selectedIndexRef = React.useRef(0);
  const keyboardNavigationRef = React.useRef(false);
  const itemRefs = React.useRef<(HTMLDivElement | null)[]>([]);
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const mobileMaxHeight = useMobileAutocompleteMaxHeight(containerRef, isMobile);
  const ignoreClickRef = React.useRef(false);
  const pointerStartRef = React.useRef<{ x: number; y: number } | null>(null);
  const pointerMovedRef = React.useRef(false);

  React.useEffect(() => {
    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (target && containerRef.current && !containerRef.current.contains(target)) onClose();
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => document.removeEventListener('pointerdown', handlePointerDown, true);
  }, [onClose]);

  const catalog = React.useMemo<CommandInfo[]>(() => resourceCommands.map((command, index) => {
    const source = normalizeSource(command.source);
    return {
      ...(command.description === undefined ? {} : { description: command.description }),
      id: `resource:${source}:${command.name}:${index}`,
      isSkill: source === 'skill',
      name: command.name,
      source,
    };
  }), [resourceCommands]);

  const mergedCatalog = React.useMemo(() => {
    const seen = new Set<string>();
    return [...additionalCommands, ...catalog].filter((command) => {
      const key = command.name.toLocaleLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [additionalCommands, catalog]);

  const commands = React.useMemo(() => {
    const filtered = searchQuery
      ? mergedCatalog.filter((command) => commandMatchesSearch(command, searchQuery))
      : [...mergedCatalog];
    const normalizedQuery = searchQuery.toLocaleLowerCase();
    return filtered.sort((left, right) => {
      const leftStarts = left.name.toLocaleLowerCase().startsWith(normalizedQuery);
      const rightStarts = right.name.toLocaleLowerCase().startsWith(normalizedQuery);
      if (leftStarts !== rightStarts) return leftStarts ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
  }, [mergedCatalog, searchQuery]);

  React.useEffect(() => setSelectedIndex(0), [commands]);
  React.useEffect(() => {
    selectedIndexRef.current = selectedIndex;
  }, [selectedIndex]);
  React.useEffect(() => {
    itemRefs.current[selectedIndex]?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  React.useImperativeHandle(ref, () => ({
    handleKeyDown: (key: string) => {
      const total = commands.length;
      if (key === 'Escape') {
        onClose();
        return;
      }
      if (total === 0) return;
      if (key === 'ArrowDown') {
        keyboardNavigationRef.current = true;
        setSelectedIndex((previous) => (previous + 1) % total);
        return;
      }
      if (key === 'ArrowUp') {
        keyboardNavigationRef.current = true;
        setSelectedIndex((previous) => (previous - 1 + total) % total);
        return;
      }
      if (key === 'Enter' || key === 'Tab') {
        const safeIndex = ((selectedIndexRef.current % total) + total) % total;
        const command = commands[safeIndex];
        if (command) onCommandSelect(command);
      }
    },
  }), [commands, onClose, onCommandSelect]);

  const getCommandIcon = (command: CommandInfo) => {
    switch (command.name) {
      case 'init': return <RiFileLine className="h-3.5 w-3.5 text-green-500" />;
      case 'undo': return <RiArrowGoBackLine className="h-3.5 w-3.5 text-orange-500" />;
      case 'redo': return <RiArrowGoForwardLine className="h-3.5 w-3.5 text-orange-500" />;
      case 'timeline': return <RiTimeLine className="h-3.5 w-3.5" />;
      case 'tree': return <RiGitBranchLine className="h-3.5 w-3.5" />;
      case 'compact': return <RiScissorsLine className="h-3.5 w-3.5 text-purple-500" />;
      case 'review': return <RiSearchEyeLine className="h-3.5 w-3.5 text-blue-500" />;
      case 'test':
      case 'build':
      case 'run': return <RiTerminalBoxLine className="h-3.5 w-3.5 text-cyan-500" />;
      default: return <RiCommandLine className="h-3.5 w-3.5 text-muted-foreground" />;
    }
  };

  return (
    <div
      ref={containerRef}
      className="absolute z-[100] min-w-0 w-full max-w-[450px] max-h-64 bg-background border-2 border-border/60 rounded-xl shadow-none bottom-full mb-2 left-0 flex flex-col"
      style={mobileMaxHeight !== undefined ? { ...style, maxHeight: mobileMaxHeight } : style}
    >
      <ScrollableOverlay preventOverscroll outerClassName="flex-1 min-h-0" className="px-0 pb-2">
        {error && <div role="alert" className="px-3 py-2 typography-meta text-destructive">{error} <button type="button" onClick={refresh}>{t('chat.timeline.retry')}</button></div>}
        {loading && commands.length === 0 ? (
          <div className="flex items-center justify-center py-4">
            <RiRefreshLine className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div>
            {commands.map((command, index) => (
              <div
                key={command.id}
                ref={(element) => { itemRefs.current[index] = element; }}
                className={cn(
                  'flex gap-2 px-3 py-2 cursor-pointer rounded-lg',
                  isMobile ? 'items-center' : 'items-start',
                  index === selectedIndex && 'bg-interactive-selection',
                )}
                onMouseDown={(event) => event.preventDefault()}
                onPointerDown={(event) => {
                  if (event.pointerType !== 'touch') return;
                  pointerStartRef.current = { x: event.clientX, y: event.clientY };
                  pointerMovedRef.current = false;
                }}
                onPointerMove={(event) => {
                  if (event.pointerType !== 'touch' || !pointerStartRef.current) return;
                  const dx = event.clientX - pointerStartRef.current.x;
                  const dy = event.clientY - pointerStartRef.current.y;
                  if (Math.hypot(dx, dy) > 6) pointerMovedRef.current = true;
                }}
                onPointerUp={(event) => {
                  if (event.pointerType !== 'touch') return;
                  const didMove = pointerMovedRef.current;
                  pointerStartRef.current = null;
                  pointerMovedRef.current = false;
                  if (didMove) return;
                  event.preventDefault();
                  event.stopPropagation();
                  ignoreClickRef.current = true;
                  onCommandSelect(command);
                }}
                onPointerCancel={() => {
                  pointerStartRef.current = null;
                  pointerMovedRef.current = false;
                }}
                onClick={() => {
                  if (ignoreClickRef.current) {
                    ignoreClickRef.current = false;
                    return;
                  }
                  onCommandSelect(command);
                }}
                onMouseMove={() => {
                  keyboardNavigationRef.current = false;
                  setSelectedIndex(index);
                }}
              >
                <div className={cn(!isMobile && 'mt-0.5')}>{getCommandIcon(command)}</div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="typography-ui-label font-medium">/{command.name}</span>
                    <span className={TYPE_BADGE_CLASS}>
                      {command.isSkill
                        ? t('chat.commandAutocomplete.badge.skill')
                        : t('chat.commandAutocomplete.badge.command')}
                    </span>
                    {command.source !== 'unknown' ? (
                      <span className={SOURCE_BADGE_CLASS}>{command.source}</span>
                    ) : null}
                  </div>
                  {command.description && !isMobile ? (
                    <div className="typography-meta text-muted-foreground mt-0.5 truncate">
                      {command.description}
                    </div>
                  ) : null}
                </div>
              </div>
            ))}
            {commands.length === 0 ? (
              <div className="px-3 py-2 typography-ui-label text-muted-foreground">
                {t('chat.commandAutocomplete.empty')}
              </div>
            ) : null}
          </div>
        )}
      </ScrollableOverlay>
      {!isMobile ? (
        <div className="px-3 pt-1 pb-1.5 border-t typography-meta text-muted-foreground">
          {t('chat.autocomplete.keyboardHint')}
        </div>
      ) : null}
    </div>
  );
});

CommandAutocomplete.displayName = 'CommandAutocomplete';
