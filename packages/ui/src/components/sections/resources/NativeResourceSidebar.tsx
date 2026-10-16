import React from 'react';
import { ProjectTrustSettings } from '@/components/sections/shared/ProjectTrustSettings';
import type { NativeResourceKind, NativeResourceScope } from '@varin/application-client';
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
import { useResourceLibraryStore } from '@/stores/useResourceLibraryStore';
import {
  createResourceStarter,
  filterResources,
  sortResources,
  validateResourceName,
} from './resource-library-model';
import { useResourceManagementTarget } from './useResourceManagementTarget';

interface NativeResourceSidebarProps {
  kind: NativeResourceKind;
  onItemSelect?: () => void;
}

const NAME_ERROR_KEYS = {
  empty: 'settings.varin.resources.nameError.empty',
  reserved: 'settings.varin.resources.nameError.reserved',
  separator: 'settings.varin.resources.nameError.separator',
} satisfies Record<'empty' | 'reserved' | 'separator', I18nKey>;

export const NativeResourceSidebar: React.FC<NativeResourceSidebarProps> = ({ kind, onItemSelect }) => {
  const { t } = useI18n();
  const { resourceTarget, targetKey, projectDirectory, trustVersion } = useResourceManagementTarget();
  const pane = useResourceLibraryStore((state) => state.panes[kind]);
  const loadCatalog = useResourceLibraryStore((state) => state.loadCatalog);
  const selectResource = useResourceLibraryStore((state) => state.selectResource);
  const createResource = useResourceLibraryStore((state) => state.createResource);
  const resetDraft = useResourceLibraryStore((state) => state.resetDraft);
  const [query, setQuery] = React.useState('');
  const [creating, setCreating] = React.useState(false);
  const [name, setName] = React.useState('');
  const [scope, setScope] = React.useState<NativeResourceScope>('user');

  React.useEffect(() => {
    void loadCatalog(kind, resourceTarget, targetKey);
  }, [kind, loadCatalog, resourceTarget, targetKey, trustVersion]);

  const resources = React.useMemo(() => (
    filterResources(sortResources(pane.catalog?.resources ?? []), query)
  ), [pane.catalog?.resources, query]);
  const dirty = pane.document !== null && pane.draft !== pane.document.content;
  const nameError = validateResourceName(name);
  const projectBlocked = scope === 'project' && (!resourceTarget.projectId || pane.catalog?.projectTrusted !== true);

  const confirmDiscard = React.useCallback(() => (
    !dirty || window.confirm(t('settings.varin.resources.discardConfirm'))
  ), [dirty, t]);

  const refresh = React.useCallback(async () => {
    if (!confirmDiscard()) return;
    const selectedId = pane.selectedId;
    resetDraft(kind);
    await loadCatalog(kind, resourceTarget, targetKey, true);
    const nextId = useResourceLibraryStore.getState().panes[kind].selectedId;
    if (nextId && nextId === selectedId) {
      await selectResource(kind, resourceTarget, targetKey, nextId);
    }
  }, [confirmDiscard, kind, loadCatalog, pane.selectedId, resetDraft, resourceTarget, selectResource, targetKey]);

  const createNew = React.useCallback(async () => {
    if (nameError || projectBlocked || pane.mutating) return;
    const success = await createResource(
      kind,
      resourceTarget,
      targetKey,
      scope,
      name.trim(),
      createResourceStarter(kind, name),
    );
    if (!success) return;
    setName('');
    setCreating(false);
    toast.success(t('settings.varin.resources.toast.created'));
    onItemSelect?.();
  }, [createResource, kind, name, nameError, onItemSelect, pane.mutating, projectBlocked, resourceTarget, scope, t, targetKey]);

  return (
    <div className="flex h-full flex-col bg-muted/25">
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
        <ProjectTrustSettings directory={projectDirectory} />
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
                  <SelectItem value="project" disabled={!resourceTarget.projectId || pane.catalog?.projectTrusted !== true}>
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
                void selectResource(kind, resourceTarget, targetKey, resource.id);
                onItemSelect?.();
              }}
              className={cn(
                'flex w-full items-start gap-3 rounded-lg border px-3 py-3 text-left transition-colors',
                selected ? 'border-border/60 bg-background shadow-sm' : 'border-transparent hover:bg-interactive-hover',
              )}
            >
<span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-background"><Icon name="file-text" className="size-4 text-muted-foreground" /></span>
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
                  {t(resource.sourceInfo.scope === 'project' ? 'settings.common.scope.project' : 'settings.varin.resources.scope.user')} · {resource.sourceInfo.source}
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
