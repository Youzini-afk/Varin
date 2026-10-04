import React from 'react';
import { markdown } from '@codemirror/lang-markdown';
import type { PiResourceKind, PiResourceScope } from '@varin/protocol';
import { Icon } from '@/components/icon/Icon';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
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
import { usePiResourcesStore } from '@/stores/usePiResourcesStore';
import { diagnosticsForPiResource, validatePiResourceName } from './resource-library-model';
import { useResourceRuntimeTarget } from './useResourceRuntimeTarget';

interface PiResourcePageProps {
  kind: PiResourceKind;
}

const statusClass = (tone: 'success' | 'warning' | 'muted'): string => {
  if (tone === 'success') return 'bg-[var(--status-success)]/10 text-[var(--status-success)]';
  if (tone === 'warning') return 'bg-[var(--status-warning)]/10 text-[var(--status-warning)]';
  return 'bg-muted text-muted-foreground';
};

export const PiResourcePage: React.FC<PiResourcePageProps> = ({ kind }) => {
  const { t } = useI18n();
  const { currentTheme } = useThemeSystem();
  const { runtimeTarget, targetKey } = useResourceRuntimeTarget();
  const pane = usePiResourcesStore((state) => state.panes[kind]);
  const loadCatalog = usePiResourcesStore((state) => state.loadCatalog);
  const selectResource = usePiResourcesStore((state) => state.selectResource);
  const setDraft = usePiResourcesStore((state) => state.setDraft);
  const resetDraft = usePiResourcesStore((state) => state.resetDraft);
  const saveResource = usePiResourcesStore((state) => state.saveResource);
  const deleteResource = usePiResourcesStore((state) => state.deleteResource);
  const copyResource = usePiResourcesStore((state) => state.copyResource);
  const [copying, setCopying] = React.useState(false);
  const [copyName, setCopyName] = React.useState('');
  const [copyScope, setCopyScope] = React.useState<PiResourceScope>('user');
  const editorExtensions = React.useMemo(() => [
    createFlexokiCodeMirrorTheme(currentTheme),
    markdown(),
  ], [currentTheme]);

  React.useEffect(() => {
    void loadCatalog(kind, runtimeTarget, targetKey);
  }, [kind, loadCatalog, runtimeTarget, targetKey]);

  const document = pane.document;
  const descriptor = document?.descriptor ?? null;
  const dirty = document !== null && pane.draft !== document.content;
  const copyNameError = validatePiResourceName(copyName);
  const projectBlocked = copyScope === 'project' && pane.catalog?.projectTrusted === false;
  const diagnostics = React.useMemo(() => (
    descriptor && pane.catalog
      ? diagnosticsForPiResource(pane.catalog.diagnostics, descriptor)
      : []
  ), [descriptor, pane.catalog]);

  React.useEffect(() => {
    setCopying(false);
    setCopyName(descriptor ? `${descriptor.name}-copy` : '');
    setCopyScope('user');
  }, [descriptor]);

  const save = React.useCallback(async () => {
    const success = await saveResource(kind, runtimeTarget, targetKey);
    if (success) toast.success(t('settings.varin.resources.toast.saved'));
  }, [kind, runtimeTarget, saveResource, t, targetKey]);

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
    await selectResource(kind, runtimeTarget, targetKey, descriptor.id);
  }, [descriptor, dirty, kind, resetDraft, runtimeTarget, selectResource, t, targetKey]);

  const remove = React.useCallback(async () => {
    if (!descriptor?.writable) return;
    const message = t('settings.varin.skills.deleteConfirm', { name: descriptor.name });
    if (!window.confirm(message)) return;
    const success = await deleteResource(kind, runtimeTarget, targetKey);
    if (success) toast.success(t('settings.varin.resources.toast.deleted'));
  }, [deleteResource, descriptor, kind, runtimeTarget, t, targetKey]);

  const copy = React.useCallback(async () => {
    if (!descriptor || copyNameError || projectBlocked || pane.mutating) return;
    const success = await copyResource(
      kind,
      runtimeTarget,
      targetKey,
      copyScope,
      copyName.trim(),
    );
    if (!success) return;
    setCopying(false);
    toast.success(t('settings.varin.resources.toast.copied'));
  }, [copyName, copyNameError, copyResource, copyScope, descriptor, kind, pane.mutating, projectBlocked, runtimeTarget, t, targetKey]);

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
          <Button type="button" variant="ghost" size="xs" disabled={pane.mutating} onClick={() => void reload()}>
            <Icon name="refresh" className={cn('size-3.5', pane.loadingDocument && 'animate-spin')} />
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!descriptor.writable || !dirty || pane.mutating}
            onClick={() => void save()}
          >
            {pane.mutating ? t('settings.common.actions.saving') : t('settings.common.actions.saveChanges')}
          </Button>
        </div>
      )}
    >
      <SettingsSection divider={false} settingsItem={`${kind}s.editor`}>
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
              {descriptor.sourceInfo.scope}
            </span>
          </div>

          <div className="rounded-lg bg-[var(--surface-elevated)] px-3 py-2">
            <p className="break-all font-mono typography-micro text-muted-foreground">{descriptor.filePath}</p>
            <p className="mt-1 typography-micro text-muted-foreground">
              {descriptor.sourceInfo.origin} · {descriptor.sourceInfo.source}
              {descriptor.disableModelInvocation ? ` · ${t('settings.varin.skills.modelInvocationDisabled')}` : ''}
            </p>
          </div>

          {!descriptor.writable ? (
            <div className="flex items-start gap-2 rounded-lg bg-[var(--status-warning)]/10 px-3 py-2 text-[var(--status-warning)]">
              <Icon name="information" className="mt-0.5 size-4 shrink-0" />
              <p className="typography-meta">{t('settings.varin.resources.readOnly.description')}</p>
            </div>
          ) : null}

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

          {diagnostics.length > 0 ? (
            <div className="space-y-2">
              {diagnostics.map((diagnostic, index) => (
                <div
                  key={`${diagnostic.type}:${diagnostic.path ?? index}`}
                  className={cn(
                    'rounded-lg px-3 py-2 typography-meta',
                    diagnostic.type === 'error'
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

      <SettingsSection
        title={t('settings.varin.resources.actions.title')}
        description={t('settings.varin.skills.actions.description')}
      >
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" size="sm" disabled={pane.mutating} onClick={() => setCopying((current) => !current)}>
              {t('settings.varin.resources.actions.copy')}
            </Button>
            {descriptor.writable ? (
              <Button type="button" variant="ghost" size="sm" disabled={pane.mutating} onClick={() => void remove()} className="text-[var(--status-error)]">
                {t('settings.varin.resources.actions.delete')}
              </Button>
            ) : null}
          </div>

          {copying ? (
            <form
              className="grid grid-cols-1 gap-2 rounded-lg border border-border/60 bg-[var(--surface-elevated)] p-3 @xl:grid-cols-[minmax(0,1fr)_10rem_auto]"
              onSubmit={(event) => {
                event.preventDefault();
                void copy();
              }}
            >
              <Input
                value={copyName}
                onChange={(event) => setCopyName(event.target.value)}
                aria-invalid={Boolean(copyName && copyNameError)}
              />
              <Select value={copyScope} onValueChange={setCopyScope}>
                <SelectTrigger size="settings"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="user">{t('settings.varin.resources.scope.user')}</SelectItem>
                  <SelectItem value="project" disabled={pane.catalog?.projectTrusted === false}>
                    {t('settings.common.scope.project')}
                  </SelectItem>
                </SelectContent>
              </Select>
              <Button type="submit" size="sm" disabled={Boolean(copyNameError) || projectBlocked || pane.mutating}>
                {t('settings.varin.resources.actions.copy')}
              </Button>
            </form>
          ) : null}
        </div>
      </SettingsSection>
    </SettingsPageLayout>
  );
};
