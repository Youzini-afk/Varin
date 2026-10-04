import React from 'react';
import type { PiResourceKind, PiResourceScope } from '@varin/protocol';
import { Icon } from '@/components/icon/Icon';
import { SettingsProjectSelector } from '@/components/sections/shared/SettingsProjectSelector';
import { SETTINGS_PANEL_TITLE_CLASS } from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from '@/components/ui';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { usePiResourcesStore } from '@/stores/usePiResourcesStore';
import {
  createPiResourceStarter,
  filterPiResources,
  sortPiResources,
  validatePiResourceName,
} from './resource-library-model';
import { useResourceRuntimeTarget } from './useResourceRuntimeTarget';

interface PiResourceSidebarProps {
  kind: PiResourceKind;
  onItemSelect?: () => void;
}

const NAME_ERROR_KEYS = {
  empty: 'settings.varin.resources.nameError.empty',
  reserved: 'settings.varin.resources.nameError.reserved',
  separator: 'settings.varin.resources.nameError.separator',
} satisfies Record<'empty' | 'reserved' | 'separator', I18nKey>;

export const PiResourceSidebar: React.FC<PiResourceSidebarProps> = ({ kind, onItemSelect }) => {
  const { t } = useI18n();
  const { runtimeTarget, targetKey } = useResourceRuntimeTarget();
  const pane = usePiResourcesStore((state) => state.panes[kind]);
  const loadCatalog = usePiResourcesStore((state) => state.loadCatalog);
  const selectResource = usePiResourcesStore((state) => state.selectResource);
  const createResource = usePiResourcesStore((state) => state.createResource);
  const resetDraft = usePiResourcesStore((state) => state.resetDraft);
  const [query, setQuery] = React.useState('');
  const [creating, setCreating] = React.useState(false);
  const [name, setName] = React.useState('');
  const [scope, setScope] = React.useState<PiResourceScope>('user');

  React.useEffect(() => {
    void loadCatalog(kind, runtimeTarget, targetKey);
  }, [kind, loadCatalog, runtimeTarget, targetKey]);

  const resources = React.useMemo(() => (
    filterPiResources(sortPiResources(pane.catalog?.resources ?? []), query)
  ), [pane.catalog?.resources, query]);
  const dirty = pane.document !== null && pane.draft !== pane.document.content;
  const nameError = validatePiResourceName(name);
  const projectBlocked = scope === 'project' && pane.catalog?.projectTrusted === false;

  const confirmDiscard = React.useCallback(() => (
    !dirty || window.confirm(t('settings.varin.resources.discardConfirm'))
  ), [dirty, t]);

  const refresh = React.useCallback(async () => {
    if (!confirmDiscard()) return;
    const selectedId = pane.selectedId;
    resetDraft(kind);
    await loadCatalog(kind, runtimeTarget, targetKey, true);
    const nextId = usePiResourcesStore.getState().panes[kind].selectedId;
    if (nextId && nextId === selectedId) {
      await selectResource(kind, runtimeTarget, targetKey, nextId);
    }
  }, [confirmDiscard, kind, loadCatalog, pane.selectedId, resetDraft, runtimeTarget, selectResource, targetKey]);

  const createNew = React.useCallback(async () => {
    if (nameError || projectBlocked || pane.mutating) return;
    const success = await createResource(
      kind,
      runtimeTarget,
      targetKey,
      scope,
      name.trim(),
      createPiResourceStarter(kind, name),
    );
    if (!success) return;
    setName('');
    setCreating(false);
    toast.success(t('settings.varin.resources.toast.created'));
    onItemSelect?.();
  }, [createResource, kind, name, nameError, onItemSelect, pane.mutating, projectBlocked, runtimeTarget, scope, t, targetKey]);

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="space-y-3 border-b px-3 pb-3 pt-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className={SETTINGS_PANEL_TITLE_CLASS}>
            {t('settings.varin.skills.sidebar.title')}
          </h2>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="h-7 w-7 px-0 text-muted-foreground"
              disabled={pane.loadingCatalog || pane.mutating}
              onClick={() => void refresh()}
              aria-label={t('settings.varin.recovery.actions.refresh')}
            >
              <Icon name="refresh" className={cn('size-3.5', pane.loadingCatalog && 'animate-spin')} />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="h-7 w-7 px-0 text-muted-foreground"
              disabled={pane.mutating}
              onClick={() => setCreating((current) => !current)}
              aria-label={t('settings.varin.resources.actions.create')}
            >
              <Icon name={creating ? 'close' : 'add'} className="size-4" />
            </Button>
          </div>
        </div>
        <SettingsProjectSelector />
        <div className="relative">
          <Icon name="search" className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('settings.varin.resources.search.placeholder')}
            className="h-8 pl-8"
          />
        </div>
        {creating ? (
          <form
            className="space-y-2 rounded-lg border border-border/60 bg-[var(--surface-elevated)] p-2.5"
            onSubmit={(event) => {
              event.preventDefault();
              void createNew();
            }}
          >
            <div className="relative">
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={'workspace-check'}
                autoFocus
                aria-invalid={Boolean(name && nameError)}
                className={undefined}
              />
            </div>
            <div className="flex items-center gap-2">
              <Select value={scope} onValueChange={setScope}>
                <SelectTrigger size="settings" className="min-w-0 flex-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="user">{t('settings.varin.resources.scope.user')}</SelectItem>
                  <SelectItem value="project" disabled={pane.catalog?.projectTrusted === false}>
                    {t('settings.common.scope.project')}
                  </SelectItem>
                </SelectContent>
              </Select>
              <Button
                type="submit"
                size="sm"
                disabled={Boolean(nameError) || projectBlocked || pane.mutating}
              >
                {t('settings.varin.resources.actions.create')}
              </Button>
            </div>
            {name && nameError ? (
              <p className="typography-micro text-[var(--status-error)]">
                {t(NAME_ERROR_KEYS[nameError])}
              </p>
            ) : null}
          </form>
        ) : null}
        <p className="typography-micro text-muted-foreground">
          {t('settings.varin.resources.total', { count: pane.catalog?.resources.length ?? 0 })}
        </p>
      </div>

      <ScrollableOverlay outerClassName="min-h-0 flex-1" className="space-y-1 overflow-x-hidden px-3 py-2">
        {!pane.loadingCatalog && resources.length === 0 ? (
          <div className="px-3 py-10 text-center text-muted-foreground">
            <Icon name={'sparkling'} className="mx-auto size-9 opacity-50" />
            <p className="mt-3 typography-ui-label">{t('settings.varin.resources.empty.title')}</p>
            <p className="mt-1 typography-meta opacity-75">{t('settings.varin.resources.empty.description')}</p>
          </div>
        ) : resources.map((resource) => {
          const selected = resource.id === pane.selectedId;
          return (
            <button
              key={resource.id}
              type="button"
              onClick={() => {
                if (selected || !confirmDiscard()) return;
                resetDraft(kind);
                void selectResource(kind, runtimeTarget, targetKey, resource.id);
                onItemSelect?.();
              }}
              className={cn(
                'flex w-full items-start gap-2 rounded-md px-2 py-2 text-left transition-colors',
                selected ? 'bg-interactive-selection' : 'hover:bg-interactive-hover',
              )}
            >
              <span className={cn(
                'mt-1.5 size-1.5 shrink-0 rounded-full',
                resource.active ? 'bg-[var(--status-success)]' : 'bg-muted-foreground/40',
              )} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate typography-ui-label text-foreground">
                    {resource.name}
                  </span>
                  {!resource.valid ? (
                    <span className="shrink-0 typography-micro text-[var(--status-warning)]">
                      {t('settings.varin.resources.status.invalid')}
                    </span>
                  ) : null}
                </span>
                <span className="mt-0.5 block truncate typography-micro text-muted-foreground">
                  {resource.sourceInfo.scope} · {resource.sourceInfo.source}
                </span>
              </span>
            </button>
          );
        })}
      </ScrollableOverlay>

      {pane.error ? (
        <div className="border-t border-[var(--status-error)]/20 bg-[var(--status-error)]/5 px-3 py-2">
          <p className="break-words typography-micro text-[var(--status-error)]">{pane.error}</p>
        </div>
      ) : null}
    </div>
  );
};
