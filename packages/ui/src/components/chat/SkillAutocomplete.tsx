import React from 'react';
import { RiRefreshLine } from '@remixicon/react';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { useI18n } from '@/lib/i18n';
import { cn, fuzzyMatch } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import type { ComposerSkill } from './useComposerResources';
import { useComposerResources } from './useComposerResources';
import { useMobileAutocompleteMaxHeight } from './useMobileAutocompleteMaxHeight';

export interface SkillAutocompleteHandle {
  handleKeyDown: (key: string) => void;
}

interface SkillAutocompleteProps {
  cwd?: string | null;
  onClose: () => void;
  onSkillSelect: (invocation: string) => void;
  searchQuery: string;
  sessionId?: string | null;
  style?: React.CSSProperties;
}

export const SkillAutocomplete = React.forwardRef<SkillAutocompleteHandle, SkillAutocompleteProps>(({
  cwd,
  onClose,
  onSkillSelect,
  searchQuery,
  sessionId,
  style,
}, ref) => {
  const { t } = useI18n();
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const isMobile = useUIStore((state) => state.isMobile);
  const mobileMaxHeight = useMobileAutocompleteMaxHeight(containerRef, isMobile);
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  const selectedIndexRef = React.useRef(0);
  const keyboardNavigationRef = React.useRef(false);
  const itemRefs = React.useRef<(HTMLDivElement | null)[]>([]);
  const { loading, skills, error, refresh } = useComposerResources({
    cwd,
    refreshOnMount: true,
    sessionId,
  });

  const filteredSkills = React.useMemo(() => {
    const normalizedQuery = searchQuery.trim();
    const matches = normalizedQuery.length
      ? skills.filter((skill) => (
          fuzzyMatch(skill.name, normalizedQuery)
          || fuzzyMatch(skill.invocation, normalizedQuery)
        ))
      : skills;

    return [...matches].sort((left, right) => {
      if (left.scope === 'project' && right.scope !== 'project') return -1;
      if (left.scope !== 'project' && right.scope === 'project') return 1;
      return left.name.localeCompare(right.name);
    });
  }, [searchQuery, skills]);

  React.useEffect(() => setSelectedIndex(0), [filteredSkills]);
  React.useEffect(() => {
    selectedIndexRef.current = selectedIndex;
  }, [selectedIndex]);
  React.useEffect(() => {
    itemRefs.current[selectedIndex]?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  React.useEffect(() => {
    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (target && containerRef.current && !containerRef.current.contains(target)) onClose();
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => document.removeEventListener('pointerdown', handlePointerDown, true);
  }, [onClose]);

  React.useImperativeHandle(ref, () => ({
    handleKeyDown: (key: string) => {
      if (key === 'Escape') {
        onClose();
        return;
      }
      if (filteredSkills.length === 0) return;
      if (key === 'ArrowDown') {
        keyboardNavigationRef.current = true;
        setSelectedIndex((previous) => (previous + 1) % filteredSkills.length);
        return;
      }
      if (key === 'ArrowUp') {
        keyboardNavigationRef.current = true;
        setSelectedIndex((previous) => (previous - 1 + filteredSkills.length) % filteredSkills.length);
        return;
      }
      if (key === 'Enter' || key === 'Tab') {
        const safeIndex = ((selectedIndexRef.current % filteredSkills.length) + filteredSkills.length) % filteredSkills.length;
        const skill = filteredSkills[safeIndex];
        if (skill) onSkillSelect(skill.invocation);
      }
    },
  }), [filteredSkills, onClose, onSkillSelect]);

  const renderSkill = (skill: ComposerSkill, index: number) => {
    const isProject = skill.scope === 'project';
    return (
      <div
        key={skill.invocation}
        ref={(element) => { itemRefs.current[index] = element; }}
        className={cn(
          'flex gap-2 px-3 py-1.5 cursor-pointer rounded-lg typography-ui-label',
          isMobile ? 'items-center' : 'items-start',
          index === selectedIndex && 'bg-interactive-selection',
        )}
        onClick={() => onSkillSelect(skill.invocation)}
        onMouseMove={() => {
          keyboardNavigationRef.current = false;
          setSelectedIndex(index);
        }}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-semibold truncate">/{skill.invocation}</span>
            <span className={cn(
              'text-[10px] leading-none uppercase font-bold tracking-tight px-1.5 py-1 rounded border flex-shrink-0 transition-colors',
              isProject
                ? 'bg-[var(--status-info-background)] text-[var(--status-info)] border-[var(--status-info-border)]'
                : 'bg-[var(--status-success-background)] text-[var(--status-success)] border-[var(--status-success-border)]',
            )}>
              {skill.scope}
            </span>
            <span className="text-[10px] leading-none uppercase font-bold tracking-tight px-1.5 py-1 rounded border flex-shrink-0 bg-[var(--surface-muted)] text-muted-foreground border-[var(--interactive-border)]/60">
              {skill.source}
            </span>
          </div>
          {skill.description && !isMobile ? (
            <div className="typography-meta text-muted-foreground mt-0.5 truncate">
              {skill.description}
            </div>
          ) : null}
        </div>
      </div>
    );
  };

  return (
    <div
      ref={containerRef}
      className="absolute z-[100] min-w-0 w-full max-w-[450px] max-h-60 bg-background border-2 border-border/60 rounded-xl shadow-none bottom-full mb-2 left-0 flex flex-col"
      style={mobileMaxHeight !== undefined ? { ...style, maxHeight: mobileMaxHeight } : style}
    >
      <ScrollableOverlay preventOverscroll outerClassName="flex-1 min-h-0" className="px-0 pb-2">
        {error && <div role="alert" className="px-3 py-2 typography-meta text-destructive">{error} <button type="button" onClick={refresh}>{t('chat.timeline.retry')}</button></div>}
        {loading && filteredSkills.length === 0 ? (
          <div className="flex items-center justify-center py-4">
            <RiRefreshLine className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : filteredSkills.length > 0 ? (
          <div>{filteredSkills.map((skill, index) => renderSkill(skill, index))}</div>
        ) : !error ? (
          <div className="px-3 py-2 typography-ui-label text-muted-foreground">
            {t('chat.fileMentionAutocomplete.empty')}
          </div>
        ) : null}
      </ScrollableOverlay>
      {!isMobile ? (
        <div className="px-3 pt-1 pb-1.5 border-t typography-meta text-muted-foreground">
          {t('chat.autocomplete.keyboardHint')}
        </div>
      ) : null}
    </div>
  );
});

SkillAutocomplete.displayName = 'SkillAutocomplete';
