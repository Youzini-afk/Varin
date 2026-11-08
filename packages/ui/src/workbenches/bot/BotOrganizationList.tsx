import React from 'react';
import { DndContext, DragOverlay, MouseSensor, TouchSensor, KeyboardSensor, closestCenter, pointerWithin, useDroppable, useSensor, useSensors, type CollisionDetection, type DragEndEvent, type DragOverEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { AnimatePresence, motion } from 'motion/react';
import { botOrganizationSections, type BotSummary } from '@varin/application-client';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { EASE_OUT, SPRINGS, springTransition } from '@/lib/motion/tokens';
import { useBotLayout } from './botLayout';
import type { BotOrganizationController } from './useBotOrganization';
import { BotGroupMenu } from './BotGroupMenu';
import type { BotOrganizationDialogState } from './BotOrganizationDialog';

type Item = { kind: 'bot'; botId: string; groupId: string | null } | { kind: 'group'; groupId: string } | { kind: 'section'; groupId: string | null };
const botKey = (id: string) => `bot:${id}`, groupKey = (id: string) => `group:${id}`;
const reorderTransition = { duration: SPRINGS.glide.visualDuration * 1000, easing: `cubic-bezier(${EASE_OUT.join(',')})` };
const collision: CollisionDetection = args => {
  const kind = args.active.data.current?.kind;
  const droppableContainers = args.droppableContainers.filter(item => kind !== 'group' || item.data.current?.kind === 'group');
  const filtered = { ...args, droppableContainers };
  const hits = pointerWithin(filtered);
  return hits.length ? hits.sort((a, b) => Number(args.droppableContainers.find(item => item.id === b.id)?.data.current?.kind === 'bot') - Number(args.droppableContainers.find(item => item.id === a.id)?.data.current?.kind === 'bot')) : closestCenter(filtered);
};

function SortableItem({ id, item, disabled, label, children }: React.PropsWithChildren<{ id: string; item: Item; disabled: boolean; label: string }>) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id, data: item, disabled, transition: reorderTransition });
  return <div ref={setNodeRef} className={`bot-sortable bot-sortable-${item.kind}`} data-dragging={isDragging || undefined}
    style={{ transform: CSS.Translate.toString(transform), transition }}>
    <button ref={setActivatorNodeRef} type="button" {...attributes} {...listeners} disabled={disabled} aria-label={label} className="bot-sort-handle"><Icon name="draggable" className="size-3.5" /></button>
    {children}
  </div>;
}
function SectionDrop({ groupId, children }: React.PropsWithChildren<{ groupId: string | null }>) {
  const { setNodeRef, isOver } = useDroppable({ id: `section:${groupId ?? ''}`, data: { kind: 'section', groupId } satisfies Item });
  return <div ref={setNodeRef} className="bot-group-drop" data-over={isOver || undefined}>{children}</div>;
}

export function BotOrganizationList({ bots, organization, selectedId, query, scope, renderBot, onDialog }: {
  bots: BotSummary[]; organization: BotOrganizationController; selectedId: string | null; query: string; scope: string;
  renderBot(bot: BotSummary): React.ReactNode; onDialog(value: BotOrganizationDialogState): void;
}) {
  const { t } = useI18n(), reduced = usePrefersReducedMotion();
  const collapsed = useBotLayout(state => state.navigatorFolded), setFolded = useBotLayout(state => state.setNavigatorFolded);
  const [dragging, setDragging] = React.useState<Item | null>(null);
  const [over, setOver] = React.useState<{ id: string; after: boolean } | null>(null);
  const [searchFolded, setSearchFolded] = React.useState<{ query: string; groups: Record<string, boolean> }>({ query: '', groups: {} });
  const sections = botOrganizationSections(bots, organization.value), needle = query.trim().toLocaleLowerCase();
  const disabled = organization.pending || !organization.ready;
  const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 6 } }), useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const onOver = (event: DragOverEvent) => {
    if (!event.over) { setOver(null); return; }
    const rect = event.active.rect.current.translated;
    const id = String(event.over.id), after = !!rect && rect.top + rect.height / 2 > event.over.rect.top + event.over.rect.height / 2;
    setOver(previous => previous?.id === id && previous.after === after ? previous : { id, after });
  };
  const finish = (event: DragEndEvent) => {
    setDragging(null); setOver(null);
    const from = event.active.data.current as Item | undefined, target = event.over?.data.current as Item | undefined;
    if (!from || !target || event.active.id === event.over?.id) return;
    const rect = event.active.rect.current.translated;
    const after = !!rect && !!event.over && rect.top + rect.height / 2 > event.over.rect.top + event.over.rect.height / 2;
    if (from.kind === 'group' && target.kind === 'group') {
      const groups = organization.value.groups.filter(group => group.id !== from.groupId), at = groups.findIndex(group => group.id === target.groupId);
      void organization.change({ kind: 'move-group', id: from.groupId, beforeId: after ? groups[at + 1]?.id ?? null : target.groupId });
    } else if (from.kind === 'bot') {
      const groupId = target.groupId;
      const rows = sections.find(section => (section.group?.id ?? null) === groupId)?.bots.filter(bot => bot.id !== from.botId) ?? [];
      const at = target.kind === 'bot' ? rows.findIndex(bot => bot.id === target.botId) : -1;
      const beforeId = at < 0 ? null : after ? rows[at + 1]?.id ?? null : rows[at]!.id;
      void organization.change({ kind: 'move-bot', botId: from.botId, groupId, beforeId }).then(saved => {
        if (saved && groupId) setFolded(JSON.stringify([scope, 'group', groupId]), false);
      });
    }
  };
  const visible = sections.filter(section => !needle || section.group?.name.toLocaleLowerCase().includes(needle) || section.bots.length > 0);
  const rows = (section: typeof sections[number]) => <SortableContext items={section.bots.map(bot => botKey(bot.id))} strategy={verticalListSortingStrategy}>
    {section.bots.map(bot => <motion.div key={bot.id} layout={dragging || reduced ? false : 'position'} transition={springTransition('glide')}
      className="bot-group-member" data-insert={over?.id === botKey(bot.id) && dragging?.kind === 'bot' && dragging.botId !== bot.id ? over.after ? 'after' : 'before' : undefined}>
      <SortableItem id={botKey(bot.id)} item={{ kind: 'bot', botId: bot.id, groupId: section.group?.id ?? null }} disabled={disabled} label={t('bot.groups.dragBot', { name: bot.name })}>{renderBot(bot)}</SortableItem>
    </motion.div>)}
  </SortableContext>;
  const draggedLabel = dragging?.kind === 'bot' ? bots.find(bot => bot.id === dragging.botId)?.name : dragging?.kind === 'group' ? organization.value.groups.find(group => group.id === dragging.groupId)?.name : '';
  return <DndContext sensors={sensors} collisionDetection={collision} onDragStart={event => setDragging(event.active.data.current as Item)} onDragOver={onOver} onDragMove={onOver} onDragEnd={finish} onDragCancel={() => { setDragging(null); setOver(null); }}
    accessibility={{ screenReaderInstructions: { draggable: t('bot.groups.dragInstructions') }, announcements: {
      onDragStart: () => t('bot.groups.dragStarted'), onDragOver: ({ over }) => over ? t('bot.groups.dragTarget') : undefined,
      onDragEnd: () => t('bot.groups.dragEnded'), onDragCancel: () => t('bot.groups.dragCancelled'),
    } }}>
    <SortableContext items={visible.flatMap(section => section.group ? [groupKey(section.group.id)] : [])} strategy={verticalListSortingStrategy}>
      <AnimatePresence initial={false}>
      {visible.map(section => {
        const group = section.group;
        if (!group) return section.bots.length || dragging?.kind === 'bot' ? <SectionDrop key="ungrouped" groupId={null}>
          {organization.value.groups.length > 0 && <div className="bot-group-label">{t('bot.groups.ungrouped')}</div>}
          {rows(section)}{!section.bots.length && <p className="bot-group-empty">{t('bot.groups.dropHere')}</p>}
        </SectionDrop> : null;
        const key = JSON.stringify([scope, 'group', group.id]);
        const open = needle ? !(searchFolded.query === needle && searchFolded.groups[group.id]) : !collapsed[key];
        const current = section.bots.find(bot => bot.id === selectedId);
        return <motion.div key={groupKey(group.id)} layout={dragging || reduced ? false : 'position'} transition={springTransition('glide')} className="bot-folder" data-open={open}
          initial={reduced ? false : { opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={reduced ? undefined : { opacity: 0, height: 0, marginTop: 0 }}>
          <SortableItem id={groupKey(group.id)} item={{ kind: 'group', groupId: group.id }} disabled={disabled} label={t('bot.groups.dragGroup', { name: group.name })}>
            <BotGroupMenu group={group} organization={organization} onDialog={onDialog}>
              <button type="button" className="bot-group-toggle" title={group.name} aria-expanded={open} onClick={() => {
                if (needle) setSearchFolded(previous => ({ query: needle, groups: { ...(previous.query === needle ? previous.groups : {}), [group.id]: open } }));
                else setFolded(key, open);
              }}>
                <Icon name="arrow-down-s" className="bot-folder-chevron size-3" /><span className="truncate">{group.name}</span>
                {!open && current && <span className="bot-group-current truncate">{current.name}</span>}
                <span className="ml-auto shrink-0 tabular-nums typography-micro text-muted-foreground">{section.bots.length}</span>
              </button>
            </BotGroupMenu>
            <div className="bot-folder-fold" inert={!open}><div><SectionDrop groupId={group.id}>
              {rows(section)}{!section.bots.length && <p className="bot-group-empty">{t('bot.groups.empty')}</p>}
            </SectionDrop></div></div>
          </SortableItem>
        </motion.div>;
      })}
      </AnimatePresence>
    </SortableContext>
    <DragOverlay dropAnimation={reduced ? null : reorderTransition}>
      {dragging && <div className="bot-group-drag-preview"><Icon name={dragging.kind === 'group' ? 'folder' : 'robot'} className="size-4" /><span className="truncate">{draggedLabel}</span></div>}
    </DragOverlay>
  </DndContext>;
}
