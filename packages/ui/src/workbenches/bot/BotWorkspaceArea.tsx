import { ExternalConversationView } from '@/components/thread/ExternalConversation';
import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { ComputerDesktopPane } from '@/components/sections/computers/ComputerDesktopView';
import { useI18n } from '@/lib/i18n';
import { useBotWorkspaceNavigation } from './botWorkspaceViews';
import { BotPanelBody } from './BotPanel';
import { BotPanelContext, type BotPanelModel } from './botPanelModel';
import { BotWorkDetail } from './BotWorkDetail';
import { BotFilesView } from './BotFilesView';
import { springTiming } from '@/lib/motion/tokens';

/** Tabs hold view state, while live desktop observation exists only for the visible view. */
export function BotWorkspaceArea({ model, active, expanded, onExpand }: { model: BotPanelModel; active: boolean; expanded: boolean; onExpand(): void }) {
  const { t } = useI18n(), navigation = useBotWorkspaceNavigation()!;
  const guards = React.useRef(new Map<string, () => boolean>());
  const binders = React.useRef(new Map<string, (guard: (() => boolean) | null) => void>());
  const previous = React.useRef(navigation.activeKey);
  const [leaving, setLeaving] = React.useState<string | null | undefined>(undefined);
  React.useLayoutEffect(() => {
    if (previous.current === navigation.activeKey) return;
    setLeaving(previous.current); previous.current = navigation.activeKey;
    const timer = setTimeout(() => setLeaving(undefined), springTiming('glide').duration);
    return () => clearTimeout(timer);
  }, [navigation.activeKey]);
  const keyboard = (event: React.KeyboardEvent) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const current = navigation.views.findIndex(view => view.key === navigation.activeKey), count = navigation.views.length;
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? count - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + count) % count;
    const view = navigation.views[index]; if (!view) return;
    navigation.select(view.key);
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[index]?.focus();
  };
  const guardFor = (key: string) => {
    let bind = binders.current.get(key);
    if (!bind) { bind = guard => { if (guard) guards.current.set(key, guard); else guards.current.delete(key); }; binders.current.set(key, bind); }
    return bind;
  };
  return <BotPanelContext.Provider value={model}><div className="bot-workspace-area" data-view={Boolean(navigation.activeKey)}>
    {navigation.views.length > 0 && <header className="bot-space-header">
      <button type="button" className="bot-space-back" onClick={() => navigation.select(null)} aria-label={t('bot.workspace.backOverview')}><Icon name="arrow-left-s" className="size-4" /><span>{model.bot.name}</span></button>
      <div role="tablist" onKeyDown={keyboard} aria-label={t('bot.workspace.viewActive')} className="bot-space-tabs">{navigation.views.map(view => <div key={view.key} className="bot-space-tab" data-selected={navigation.activeKey === view.key}>
        <button type="button" role="tab" tabIndex={navigation.activeKey === view.key || navigation.activeKey === null && view === navigation.views[0] ? 0 : -1} aria-selected={navigation.activeKey === view.key} onClick={() => navigation.select(view.key)}><Icon name={view.kind === 'files' ? 'folder' : view.kind === 'computer' ? 'computer' : 'list-unordered'} className="size-3.5" /><span>{view.title}</span></button>
        <button type="button" aria-label={`${t('bot.workspace.close')} · ${view.title}`} onClick={() => { if (guards.current.get(view.key)?.() === false) return; navigation.close(view.key); }}><Icon name="close" className="size-3" /></button>
      </div>)}</div>
      {navigation.activeKey && <button type="button" className="bot-space-expand" aria-label={t(expanded ? 'bot.workspace.restore' : 'bot.workspace.expand')} onClick={onExpand}><Icon name={expanded ? 'fullscreen-exit' : 'fullscreen'} className="size-4" /></button>}
    </header>}
    <div className="bot-space-body">
      <div className="bot-space-page" data-leaving={leaving === null || undefined} hidden={Boolean(navigation.activeKey) && leaving !== null} inert={Boolean(navigation.activeKey)}><BotPanelBody model={model} /></div>
      {navigation.views.map(view => <div key={view.key} className="bot-space-page" data-leaving={leaving === view.key || undefined} hidden={navigation.activeKey !== view.key && leaving !== view.key} inert={navigation.activeKey !== view.key}>
        {view.kind === 'external' ? (active && navigation.activeKey === view.key ? <ExternalConversationView id={view.id} /> : null) : view.kind === 'work' ? <BotWorkDetail identity={view.identity} active={active && navigation.activeKey === view.key} />
          : view.kind === 'files' ? <BotFilesView view={view} active={active && navigation.activeKey === view.key} setCloseGuard={guardFor(view.key)} />
            : active && navigation.activeKey === view.key ? <div className="bot-computer-view"><h2><Icon name="computer" className="size-4" />{view.desktop.label}</h2><ComputerDesktopPane desktop={view.desktop} /></div> : null}
      </div>)}
    </div>
  </div></BotPanelContext.Provider>;
}
