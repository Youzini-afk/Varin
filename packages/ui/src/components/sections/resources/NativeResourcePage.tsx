import React from 'react';
import { markdown } from '@codemirror/lang-markdown';
import type { NativeResourceKind, NativeResourceScope } from '@varin/application-client';
import { Icon } from '@/components/icon/Icon';
import { SettingsActionBar } from '@/components/sections/shared/SettingsActionBar';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { CodeMirrorEditor } from '@/components/ui/CodeMirrorEditor';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from '@/components/ui';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { createFlexokiCodeMirrorTheme } from '@/lib/codemirror/flexokiTheme';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useResourceLibraryStore } from '@/stores/useResourceLibraryStore';
import { diagnosticsForResource, validateResourceName } from './resource-library-model';
import { useResourceManagementTarget } from './useResourceManagementTarget';

interface NativeResourcePageProps {
  kind: NativeResourceKind;
}

const statusClass = (tone: 'success' | 'warning' | 'muted'): string => {
  if (tone === 'success') return 'bg-[var(--status-success)]/10 text-[var(--status-success)]';
  if (tone === 'warning') return 'bg-[var(--status-warning)]/10 text-[var(--status-warning)]';
  return 'bg-muted text-muted-foreground';
};

export const NativeResourcePage: React.FC<NativeResourcePageProps> = ({ kind }) => {
  const { t } = useI18n();
  const { currentTheme } = useThemeSystem();
  const { resourceTarget, targetKey, trustVersion } = useResourceManagementTarget();
  const pane = useResourceLibraryStore((state) => state.panes[kind]);
  const loadCatalog = useResourceLibraryStore((state) => state.loadCatalog);
  const selectResource = useResourceLibraryStore((state) => state.selectResource);
  const setDraft = useResourceLibraryStore((state) => state.setDraft);
  const resetDraft = useResourceLibraryStore((state) => state.resetDraft);
  const saveResource = useResourceLibraryStore((state) => state.saveResource);
  const deleteResource = useResourceLibraryStore((state) => state.deleteResource);
  const copyResource = useResourceLibraryStore((state) => state.copyResource);
  const [copying, setCopying] = React.useState(false);
  const [copyName, setCopyName] = React.useState('');
  const [copyScope, setCopyScope] = React.useState<NativeResourceScope>('user');
  const editorExtensions = React.useMemo(() => [
    createFlexokiCodeMirrorTheme(currentTheme),
    markdown(),
  ], [currentTheme]);

  React.useEffect(() => {
    void loadCatalog(kind, resourceTarget, targetKey);
  }, [kind, loadCatalog, resourceTarget, targetKey, trustVersion]);

  const document = pane.document;
  const descriptor = document?.descriptor ?? null;
  const dirty = document !== null && pane.draft !== document.content;
  const copyNameError = validateResourceName(copyName);
  const projectBlocked = copyScope === 'project' && (!resourceTarget.projectId || pane.catalog?.projectTrusted !== true);
  const diagnostics = React.useMemo(() => (
    descriptor && pane.catalog
      ? diagnosticsForResource(pane.catalog.diagnostics, descriptor)
      : []
  ), [descriptor, pane.catalog]);

  React.useEffect(() => {
    setCopying(false);
    setCopyName(descriptor ? `${descriptor.name}-copy` : '');
    setCopyScope('user');
  }, [descriptor]);

  const save = React.useCallback(async () => {
    const success = await saveResource(kind, resourceTarget, targetKey);
    if (success) toast.success(t('settings.varin.resources.toast.saved'));
    return success;
  }, [kind, resourceTarget, saveResource, t, targetKey]);

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') return;
      if (!descriptor?.writable || !dirty || pane.mutating) return;
      event.preventDefault();
      void save();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [descriptor?.writable, dirty, pane.mutating, save]);

  const reload = React.useCallback(async () => {
    if (!descriptor) return;
    if (dirty && !window.confirm(t('settings.varin.resources.discardConfirm'))) return;
    resetDraft(kind);
    await selectResource(kind, resourceTarget, targetKey, descriptor.id);
  }, [descriptor, dirty, kind, resetDraft, resourceTarget, selectResource, t, targetKey]);

  const remove = React.useCallback(async () => {
    if (!descriptor?.writable) return;
    const message = t('settings.varin.skills.deleteConfirm', { name: descriptor.name });
    if (!window.confirm(message)) return;
    const success = await deleteResource(kind, resourceTarget, targetKey);
    if (success) toast.success(t('settings.varin.resources.toast.deleted'));
  }, [deleteResource, descriptor, kind, resourceTarget, t, targetKey]);

  const copy = React.useCallback(async () => {
    if (!descriptor || copyNameError || projectBlocked || pane.mutating) return;
    const success = await copyResource(
      kind,
      resourceTarget,
      targetKey,
      copyScope,
      copyName.trim(),
    );
    if (!success) return;
    setCopying(false);
    toast.success(t('settings.varin.resources.toast.copied'));
  }, [copyName, copyNameError, copyResource, copyScope, descriptor, kind, pane.mutating, projectBlocked, resourceTarget, t, targetKey]);

  const title = t('settings.page.skills.title');
  const description = t('settings.varin.skills.description');

  if (!document || !descriptor) {
    return (
      <SettingsPageLayout title={title} description={description} showSaveStatus={false}>
        <div className="flex min-h-80 items-center justify-center rounded-lg border border-dashed border-border/60 px-6 text-center">
          <div className="max-w-sm text-muted-foreground">
            <Icon
              name={pane.loadingDocument || pane.loadingCatalog ? 'loader-4' : 'sparkling'}
              className={cn('mx-auto size-10 opacity-50', (pane.loadingDocument || pane.loadingCatalog) && 'animate-spin')}
            />
            <p className="mt-3 typography-ui-label text-foreground">
              {pane.loadingDocument || pane.loadingCatalog
                ? t('settings.varin.resources.loading')
                : t('settings.varin.resources.emptySelection.title')}
            </p>
            <p className="mt-1 typography-meta">
              {t('settings.varin.resources.emptySelection.description')}
            </p>
          </div>
        </div>
        {pane.error ? (
          <p className="mt-3 break-words typography-meta text-[var(--status-error)]">{pane.error}</p>
        ) : null}
      </SettingsPageLayout>
    );
  }

  return (
    <SettingsPageLayout
      title={descriptor.name}
      description={descriptor.description || description}
      showSaveStatus={false}
      headerEnd={(
        <div className="flex items-center gap-2">
          <Button type="button" variant="ghost" size="xs" disabled={pane.mutating} onClick={() => void reload()} aria-label={t('settings.varin.recovery.actions.refresh')}>
            <Icon name="refresh" className={cn('size-3.5', pane.loadingDocument && 'animate-spin')} />
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={pane.mutating} onClick={() => setCopying(current => !current)}>{t('settings.varin.resources.actions.copy')}</Button>
          {descriptor.writable ? <Button type="button" variant="ghost" size="sm" disabled={pane.mutating} onClick={() => void remove()} aria-label={t('settings.varin.resources.actions.delete')}><Icon name="delete-bin" className="size-4" /></Button> : null}
        </div>
      )}
    >
      <SettingsSection divider={false}>
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn('rounded-full px-2 py-0.5 typography-micro', statusClass(descriptor.active ? 'success' : 'muted'))}>
              {descriptor.active
                ? t('settings.varin.resources.status.active')
                : t('settings.varin.resources.status.inactive')}
            </span>
            <span className={cn('rounded-full px-2 py-0.5 typography-micro', statusClass(descriptor.valid ? 'success' : 'warning'))}>
              {descriptor.valid
                ? t('settings.varin.resources.status.valid')
                : t('settings.varin.resources.status.invalid')}
            </span>
            <span className={cn('rounded-full px-2 py-0.5 typography-micro', statusClass(descriptor.writable ? 'success' : 'muted'))}>
              {descriptor.writable
                ? t('settings.varin.resources.status.writable')
                : t('settings.varin.resources.status.readOnly')}
            </span>
            <span className="rounded-full bg-muted px-2 py-0.5 typography-micro text-muted-foreground">
              {t(descriptor.sourceInfo.scope === 'project' ? 'settings.common.scope.project' : 'settings.varin.resources.scope.user')}
            </span>
          </div>

          {!descriptor.writable ? (
            <div className="flex items-start gap-2 rounded-lg bg-[var(--status-warning)]/10 px-3 py-2 text-[var(--status-warning)]">
              <Icon name="information" className="mt-0.5 size-4 shrink-0" />
              <p className="typography-meta">{t('settings.varin.resources.readOnly.description')}</p>
            </div>
          ) : null}

          <div className="flex items-center justify-between typography-micro text-muted-foreground"><span className="rounded bg-muted px-1.5 py-0.5 font-mono">SKILL.md</span>{descriptor.writable ? <span>⌘S / Ctrl S</span> : null}</div>
          <div className="h-[34rem] min-h-80 overflow-hidden rounded-lg border border-border/60 bg-background">
            <CodeMirrorEditor
              value={pane.draft}
              onChange={(value) => setDraft(kind, value)}
              extensions={editorExtensions}
              className="h-full"
              enableSearch
              readOnly={!descriptor.writable || pane.mutating}
            />
          </div>

          <details className="border-t border-border/60 pt-3"><summary className="cursor-pointer typography-meta text-muted-foreground">{t('settings.varin.resources.sourceDetails')}</summary>
          <div className="rounded-lg bg-[var(--surface-elevated)] px-3 py-2">
            <p className="break-all font-mono typography-micro text-muted-foreground">{descriptor.filePath}</p>
            <p className="mt-1 typography-micro text-muted-foreground">
              {descriptor.sourceInfo.origin} · {descriptor.sourceInfo.source}
              {descriptor.disableModelInvocation ? ` · ${t('settings.varin.skills.modelInvocationDisabled')}` : ''}
            </p>
          </div>
          </details>
          {diagnostics.length > 0 ? (
            <div className="space-y-2">
              {diagnostics.map((diagnostic, index) => (
                <div
                  key={`${diagnostic.kind}:${diagnostic.path ?? index}`}
                  className={cn(
                    'rounded-lg px-3 py-2 typography-meta',
                    diagnostic.kind === 'error'
                      ? 'bg-[var(--status-error)]/10 text-[var(--status-error)]'
                      : 'bg-[var(--status-warning)]/10 text-[var(--status-warning)]',
                  )}
                >
                  {diagnostic.message}
                </div>
              ))}
            </div>
          ) : null}

          {pane.error ? (
            <div className="rounded-lg bg-[var(--status-error)]/10 px-3 py-2 typography-meta text-[var(--status-error)]">
              {pane.error}
            </div>
          ) : null}
        </div>
      </SettingsSection>

      <Dialog open={copying} onOpenChange={open => { if (!pane.mutating) setCopying(open); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('settings.varin.resources.actions.copy')}</DialogTitle><DialogDescription>{t('settings.varin.skills.actions.description')}</DialogDescription></DialogHeader>
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                void copy();
              }}
            >
              <Input
                aria-label={t('settings.agents.name')}
                value={copyName}
                onChange={(event) => setCopyName(event.target.value)}
                aria-invalid={Boolean(copyName && copyNameError)}
              />
              {copyName && copyNameError ? <p role="alert" className="typography-meta text-destructive">{t(`settings.varin.resources.nameError.${copyNameError}`)}</p> : null}
              <Select value={copyScope} onValueChange={setCopyScope}>
                <SelectTrigger size="settings"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="user">{t('settings.varin.resources.scope.user')}</SelectItem>
                  <SelectItem value="project" disabled={!resourceTarget.projectId || pane.catalog?.projectTrusted !== true}>
                    {t('settings.common.scope.project')}
                  </SelectItem>
                </SelectContent>
              </Select>
              <div className="flex justify-end gap-2"><Button type="button" variant="ghost" size="sm" disabled={pane.mutating} onClick={() => setCopying(false)}>{t('settings.common.actions.cancel')}</Button>
              <Button type="submit" size="sm" disabled={Boolean(copyNameError) || projectBlocked || pane.mutating}>
                {t('settings.varin.resources.actions.copy')}
              </Button></div>
            </form>
        </DialogContent>
      </Dialog>
      {descriptor.writable ? <SettingsActionBar dirty={dirty} saving={pane.mutating} onSave={save} onCancel={() => resetDraft(kind)} saveLabel={t('settings.common.actions.saveChanges')} error={pane.error} /> : null}
    </SettingsPageLayout>
  );
};
