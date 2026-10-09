import React from 'react';
import type {
  VarinExtensionActualStatus,
  VarinExtensionCatalogEntry,
  VarinExtensionCapabilityReference,
  VarinExtensionHostStateSnapshot,
} from '@varin/extension-contract';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from '@/components/ui';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import {
  SettingsFieldRow,
  SettingsRadioGroup,
  SettingsRadioOption,
  SettingsSection,
} from '@/components/sections/shared/SettingsSection';
import {
  refreshVarinExtensionCatalog,
  discardVarinExtensionCandidate,
  installVarinExtension,
  reloadVarinExtensionLocalSource,
  removeVarinExtension,
  reviewVarinExtensionCapabilities,
  reviewVarinExtensionCandidateCapabilities,
  selectVarinExtensionCandidate,
  setVarinExtensionServiceRoute,
  setVarinExtensionEnabled,
  useVarinExtensionCatalog,
} from '@/lib/extensions/catalog-store';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useWorkbenchWorkspaceId } from '@/lib/extensions/workbench-workspace';
import {
  VARIN_EDITOR_MONACO_SERVICE_ID,
  VARIN_EDITOR_MONACO_SERVICE_VERSION,
  VARIN_RETRIEVAL_PLAN_SERVICE_ID,
  VARIN_RETRIEVAL_PLAN_VERSION,
  resolveVarinExtensionServiceRouting,
  resolveVarinWorkbenchLayout,
  resolveVarinWorkbenchProfile,
  serviceRoutingScopeKey,
} from '@varin/extension-contract';
import { VARIN_BUILTIN_RETRIEVAL_DEFAULT_PROVIDER_KEY } from '@varin/extension-builtins';
import { serviceRoutingOptions } from '@/lib/extensions/service-routing-options';
import {
  selectActiveWorkbenchProfile,
  applyWorkbenchProfile,
  removeWorkbenchProfile,
  setWorkbenchReplacementSelection,
  upsertWorkbenchProfile,
  useSurfaceRegistrySnapshot,
  WORKBENCH_REPLACEMENT_TARGETS,
} from '@/lib/extensions/workbench-registry';
import { varinSurfaceRuntime } from '@/lib/extensions/surface-runtime';
import { workbenchExtensionDisplayName, workbenchProfileLabel } from '@/lib/extensions/workbench-profile-label';
import {
  describeWorkbenchContributionPlacement,
  describeWorkbenchShellSeams,
  workbenchInspectorOwnsDocuments,
  workbenchInspectorOwnsLanguage,
  workbenchInspectorOwnsDebugCapability,
  workbenchInspectorOwnsTestCapability,
  workbenchInspectorOwnsRun,
} from '@/lib/extensions/workbench-inspector';
import { projectWorkbenchSeams } from '@/lib/extensions/workbench-seams';
import {
  getWorkbenchCompositionInspectorSnapshot,
  subscribeWorkbenchCompositionInspector,
} from '@/lib/extensions/workbench-composition-host';
import {
  getMonacoExtensionInspectorSnapshot,
  subscribeMonacoExtensionInspector,
} from '@/lib/monaco/extension-service';

const STATUS_KEYS: Readonly<Record<VarinExtensionActualStatus, I18nKey>> = {
  active: 'settings.varin.extensions.status.active',
  activating: 'settings.varin.extensions.status.activating',
  deactivating: 'settings.varin.extensions.status.deactivating',
  failed: 'settings.varin.extensions.status.failed',
  inactive: 'settings.varin.extensions.status.inactive',
  loading: 'settings.varin.extensions.status.loading',
  resolving: 'settings.varin.extensions.status.resolving',
  'restart-required': 'settings.varin.extensions.status.restartRequired',
  'rolling-back': 'settings.varin.extensions.status.rollingBack',
  updating: 'settings.varin.extensions.status.updating',
  waiting: 'settings.varin.extensions.status.waiting',
};

const actualStatus = (entry: VarinExtensionCatalogEntry): VarinExtensionActualStatus => {
  if (!entry.desired.enabled) return 'inactive';
  const statuses = entry.actual.map((state) => state.status);
  for (const status of ['restart-required', 'failed', 'rolling-back', 'updating', 'deactivating', 'activating', 'loading', 'resolving', 'waiting', 'active'] as const) {
    if (statuses.includes(status)) return status;
  }
  return 'waiting';
};

const capabilityKey = (reference: VarinExtensionCapabilityReference): string => (
  `${reference.realm}:${reference.capability}`
);

const MonacoServiceInspectorRows: React.FC<{
  declared: boolean;
  extensionId: string;
  hasOtherServices: boolean;
}> = ({ declared, extensionId, hasOtherServices }) => {
  const { t } = useI18n();
  const snapshot = React.useSyncExternalStore(
    subscribeMonacoExtensionInspector,
    getMonacoExtensionInspectorSnapshot,
    getMonacoExtensionInspectorSnapshot,
  );
  const owners = snapshot.owners.filter((owner) => owner.extensionId === extensionId);
  if (!declared && !hasOtherServices) {
    return <span className="typography-micro text-muted-foreground">—</span>;
  }
  if (!declared) return null;
  if (owners.length === 0) {
    return (
      <div className="break-all typography-micro text-muted-foreground">
        surface-local · {VARIN_EDITOR_MONACO_SERVICE_ID}@{VARIN_EDITOR_MONACO_SERVICE_VERSION} · {t('settings.varin.extensions.status.inactive')}
      </div>
    );
  }
  return (
    <>
      {owners.map((owner) => (
        <div key={`${owner.realmId}:${owner.entrypointId}:${owner.generation}`} className="break-all typography-micro text-muted-foreground">
          surface-local · {VARIN_EDITOR_MONACO_SERVICE_ID}@{VARIN_EDITOR_MONACO_SERVICE_VERSION} · {t('settings.varin.extensions.status.active')}
          {` · generation #${owner.generation} · registrations ${owner.registrationCount}`}
        </div>
      ))}
      {snapshot.views.map((view) => (
        <div key={`${view.viewId}:${view.generation}`} className="break-all typography-micro text-muted-foreground">
          view · {view.viewId} · {view.workspaceId}/{view.resourceId} · {view.providerId}
          {` · generation #${view.generation} · document #${view.documentVersion}`}
          {snapshot.activeViewId === view.viewId ? ' · active' : ''}
        </div>
      ))}
    </>
  );
};

const WORKBENCH_TARGET_LABELS: Readonly<Record<string, I18nKey>> = {
  [WORKBENCH_REPLACEMENT_TARGETS.shell]: 'settings.varin.extensions.workbench.target.shell',
  [WORKBENCH_REPLACEMENT_TARGETS.sessionNavigator]: 'settings.varin.extensions.workbench.target.navigator',
  [WORKBENCH_REPLACEMENT_TARGETS.chatTimeline]: 'settings.varin.extensions.workbench.target.timeline',
  [WORKBENCH_REPLACEMENT_TARGETS.chatComposer]: 'settings.varin.extensions.workbench.target.composer',
  [WORKBENCH_REPLACEMENT_TARGETS.agents]: 'settings.varin.extensions.workbench.target.agents',
  [WORKBENCH_REPLACEMENT_TARGETS.mcp]: 'settings.varin.extensions.workbench.target.mcp',
  [WORKBENCH_REPLACEMENT_TARGETS.workspaceExplorer]: 'settings.varin.extensions.workbench.target.explorer',
  [WORKBENCH_REPLACEMENT_TARGETS.settings]: 'settings.varin.extensions.workbench.target.settings',
  [WORKBENCH_REPLACEMENT_TARGETS.activity]: 'settings.varin.extensions.workbench.target.activity',
  [WORKBENCH_REPLACEMENT_TARGETS.primarySidebar]: 'settings.varin.extensions.workbench.target.primarySidebar',
  [WORKBENCH_REPLACEMENT_TARGETS.editor]: 'settings.varin.extensions.workbench.target.editor',
  [WORKBENCH_REPLACEMENT_TARGETS.secondarySidebar]: 'settings.varin.extensions.workbench.target.secondarySidebar',
  [WORKBENCH_REPLACEMENT_TARGETS.panel]: 'settings.varin.extensions.workbench.target.panel',
  [WORKBENCH_REPLACEMENT_TARGETS.status]: 'settings.varin.extensions.workbench.target.status',
  [WORKBENCH_REPLACEMENT_TARGETS.transition]: 'settings.varin.extensions.workbench.target.transition',
};

const SHELL_STATUS_KEYS: Readonly<Record<ReturnType<typeof resolveVarinWorkbenchProfile>['status'], I18nKey>> = {
  builtin: 'settings.varin.extensions.workbench.shellStatus.builtin',
  ready: 'settings.varin.extensions.workbench.shellStatus.ready',
  missing: 'settings.varin.extensions.workbench.shellStatus.missing',
  disabled: 'settings.varin.extensions.workbench.shellStatus.disabled',
  failed: 'settings.varin.extensions.workbench.shellStatus.failed',
};

const WorkbenchProfileSection: React.FC = () => {
  const { t } = useI18n();
  const catalog = useVarinExtensionCatalog();
  const surface = useSurfaceRegistrySnapshot();
  const workspaceId = useWorkbenchWorkspaceId();
  const [createOpen, setCreateOpen] = React.useState(false);
  const [removeOpen, setRemoveOpen] = React.useState(false);
  const [profileName, setProfileName] = React.useState('');
  const [profileBusy, setProfileBusy] = React.useState(false);
  const workbench = catalog.snapshot?.workbench;
  if (!workbench?.authoritative || !catalog.snapshot) return null;
  const resolved = resolveVarinWorkbenchLayout(workbench.document, {
    surface: varinSurfaceRuntime.surface,
    userId: 'default',
    ...(workspaceId ? { workspaceId } : {}),
  });
  const profileResolution = resolveVarinWorkbenchProfile(workbench.document, catalog.snapshot.catalog, {
    surface: varinSurfaceRuntime.surface,
    userId: 'default',
    ...(workspaceId ? { workspaceId } : {}),
  });
  const profile = workbench.document.profiles.find((candidate) => candidate.id === resolved.profileId);
  if (!profile) return null;
  const installedExtensions = catalog.snapshot?.catalog.extensions ?? [];
  const installedExtensionIds = new Set(installedExtensions.map((entry) => entry.manifest.id));
  const selectedExtensions = new Set(profile.extensionIds
    ?? installedExtensions.filter((entry) => entry.desired.enabled).map((entry) => entry.manifest.id));
  const missingExtensionIds = [...selectedExtensions].filter((extensionId) => !installedExtensionIds.has(extensionId)).sort();
  const seamProjections = projectWorkbenchSeams({
    layout: resolved,
    shellContributionId: profileResolution.shellContributionId,
    shellExtensionId: profileResolution.shellExtensionId,
    shellStatus: profileResolution.status,
    catalog: installedExtensions,
    surface: varinSurfaceRuntime.surface,
    visibleContributions: surface.contributions,
  });
  const run = (operation: Promise<void>) => {
    void operation.catch((error) => toast.error(error instanceof Error ? error.message : String(error)));
  };
  const requestProfile = async (profileId: string): Promise<void> => {
    setProfileBusy(true);
    try {
      await selectActiveWorkbenchProfile(profileId, workspaceId, { enableShell: true });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setProfileBusy(false);
    }
  };
  const updateExtensionSet = async (extensionId: string, enabled: boolean): Promise<void> => {
    const next = new Set(selectedExtensions);
    if (enabled) next.add(extensionId);
    else next.delete(extensionId);
    setProfileBusy(true);
    try {
      await upsertWorkbenchProfile({ ...profile, extensionIds: [...next].sort() });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setProfileBusy(false);
    }
  };
  const createProfile = async (): Promise<void> => {
    const label = profileName.trim();
    if (!label) return;
    const slug = label.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
    const generated = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().slice(0, 8)
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const id = slug || `profile-${generated}`;
    if (workbench.document.profiles.some((candidate) => candidate.id === id)) {
      toast.error(t('settings.varin.extensions.workbench.profileExists'));
      return;
    }
    setProfileBusy(true);
    try {
      await upsertWorkbenchProfile({ extensionIds: [...selectedExtensions].sort(), id, label });
      await requestProfile(id);
      setProfileName('');
      setCreateOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setProfileBusy(false);
    }
  };
  return (
    <SettingsSection title={t('settings.varin.extensions.workbench.title')} settingsItem="extensions.workbench">
      <div className="space-y-3">
        <SettingsFieldRow
          label={t('settings.varin.extensions.workbench.profile')}
          settingsItem="extensions.workbench.profile"
          controlClassName="w-full max-w-none"
        >
          <div className="flex min-w-0 w-full gap-2">
            <Select
              value={resolved.profileId}
              onValueChange={(profileId) => { void requestProfile(profileId); }}
            >
              <SelectTrigger className="min-w-0 flex-1" disabled={profileBusy}><SelectValue /></SelectTrigger>
              <SelectContent>
                {workbench.document.profiles.map((candidate) => (
                  <SelectItem key={candidate.id} value={candidate.id}>{workbenchProfileLabel(candidate, t)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button type="button" variant="outline" size="icon" onClick={() => setCreateOpen(true)} aria-label={t('settings.varin.extensions.workbench.createProfile')}>
              <Icon name="add" className="size-4" />
            </Button>
            {workbench.document.profiles.length > 1 ? (
              <Button type="button" variant="ghost" size="icon" onClick={() => setRemoveOpen(true)} aria-label={t('settings.varin.extensions.workbench.removeProfile')}>
                <Icon name="delete-bin" className="size-4" />
              </Button>
            ) : null}
          </div>
        </SettingsFieldRow>
        <SettingsFieldRow
          label={t('settings.varin.extensions.workbench.selectedShell')}
          settingsItem="extensions.workbench.shell"
          controlClassName="w-full max-w-none"
        >
          <div className="flex min-w-0 w-full flex-col items-start gap-2 @xl:items-end">
            <span className="typography-meta text-muted-foreground">
              {profileResolution.shellContributionId ?? t('settings.varin.extensions.workbench.builtin')}
              {' · '}
              {t(SHELL_STATUS_KEYS[profileResolution.status])}
            </span>
            {profileResolution.status === 'disabled' && profileResolution.shellExtensionId ? (
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={profileBusy}
                onClick={() => { void requestProfile(resolved.profileId); }}
              >
                {t('settings.varin.extensions.workbench.enableAndSwitch')}
              </Button>
            ) : null}
          </div>
        </SettingsFieldRow>
        <div className="rounded-lg border border-border/60 px-3 py-3" data-settings-item="extensions.workbench.extensionSet">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="typography-ui-label text-foreground">{t('settings.varin.extensions.workbench.extensionSet')}</span>
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={profileBusy || profile.extensionIds === undefined}
              onClick={() => {
                setProfileBusy(true);
                void applyWorkbenchProfile(profile.id).catch((error) => {
                  toast.error(error instanceof Error ? error.message : String(error));
                }).finally(() => setProfileBusy(false));
              }}
            >
              {t('settings.varin.extensions.workbench.applyProfile')}
            </Button>
          </div>
          <div className="grid gap-2 @2xl:grid-cols-2">
            {installedExtensions.map((entry) => (
              <label key={entry.manifest.id} className="flex min-w-0 items-center justify-between gap-3 rounded-md bg-interactive-hover px-2.5 py-2">
                <span className="min-w-0 truncate typography-meta text-foreground">
                  {workbenchExtensionDisplayName(entry, t)}
                </span>
                <Switch
                  checked={selectedExtensions.has(entry.manifest.id)}
                  disabled={profileBusy}
                  onCheckedChange={(enabled) => { void updateExtensionSet(entry.manifest.id, enabled); }}
                />
              </label>
            ))}
            {missingExtensionIds.map((extensionId) => (
              <label key={extensionId} className="flex min-w-0 items-center justify-between gap-3 rounded-md bg-interactive-hover px-2.5 py-2">
                <span className="min-w-0">
                  <span className="block truncate typography-meta text-foreground">{extensionId}</span>
                  <span className="block typography-micro text-muted-foreground">{t('settings.varin.extensions.workbench.notInstalled')}</span>
                </span>
                <Switch
                  checked
                  disabled={profileBusy}
                  onCheckedChange={(enabled) => { void updateExtensionSet(extensionId, enabled); }}
                />
              </label>
            ))}
          </div>
        </div>
        {seamProjections.map((projection) => {
          const target = projection.target;
          const label = WORKBENCH_TARGET_LABELS[target] ? t(WORKBENCH_TARGET_LABELS[target]) : target;
          const scopeOverride = workspaceId
            ? { scope: 'workspace' as const, scopeId: workspaceId }
            : { scope: 'user' as const, scopeId: 'default' };
          if (projection.status === 'platform') {
            const selectedMissing = projection.selected !== '__builtin__'
              && !projection.candidates.some((candidate) => candidate.descriptor.id === projection.selected);
            return (
              <div key={target} className="grid gap-2 @xl:grid-cols-[minmax(0,1fr)_minmax(13rem,0.8fr)] @xl:items-center">
                <div className="min-w-0">
                  <span className="typography-ui-label text-foreground">{label}</span>
                  <span className="ml-2 typography-micro text-muted-foreground">
                    {t('settings.varin.extensions.workbench.platformManaged')}
                  </span>
                </div>
                <Select
                  value={projection.selected}
                  onValueChange={(value) => run(setWorkbenchReplacementSelection(
                    target,
                    value === '__builtin__' ? null : value,
                    scopeOverride,
                  ))}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__builtin__">{t('settings.varin.extensions.workbench.builtin')}</SelectItem>
                    {selectedMissing ? <SelectItem value={projection.selected}>{projection.selected}</SelectItem> : null}
                    {projection.candidates.map((candidate) => (
                      <SelectItem key={candidate.descriptor.id} value={candidate.descriptor.id}>
                        {candidate.descriptor.title ?? candidate.descriptor.id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            );
          }
          if (projection.status === 'dormant') {
            return (
              <div key={target} className="grid gap-2 @xl:grid-cols-[minmax(0,1fr)_minmax(13rem,0.8fr)] @xl:items-center">
                <div className="min-w-0">
                  <span className="typography-ui-label text-foreground">{label}</span>
                  <span className="ml-2 typography-micro text-muted-foreground">
                    {t('settings.varin.extensions.workbench.dormant')}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="min-w-0 truncate typography-meta text-muted-foreground">{projection.selected}</span>
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    disabled={profileBusy}
                    onClick={() => run(setWorkbenchReplacementSelection(target, null, scopeOverride))}
                  >
                    {t('settings.varin.extensions.workbench.clearOverride')}
                  </Button>
                </div>
              </div>
            );
          }
          if (projection.status === 'missing-selection') {
            return (
              <div key={target} className="grid gap-2 @xl:grid-cols-[minmax(0,1fr)_minmax(13rem,0.8fr)] @xl:items-center">
                <div className="min-w-0">
                  <span className="typography-ui-label text-foreground">{label}</span>
                  <span className="ml-2 typography-micro text-warning">
                    {t('settings.varin.extensions.workbench.missingSelection')}
                  </span>
                </div>
                <Select
                  value={projection.selected}
                  onValueChange={(value) => run(setWorkbenchReplacementSelection(
                    target,
                    value === '__builtin__' ? null : value,
                    scopeOverride,
                  ))}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__builtin__">{t('settings.varin.extensions.workbench.builtin')}</SelectItem>
                    <SelectItem value={projection.selected}>{projection.selected}</SelectItem>
                    {projection.candidates.map((candidate) => (
                      <SelectItem key={candidate.descriptor.id} value={candidate.descriptor.id}>
                        {candidate.descriptor.title ?? candidate.descriptor.id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            );
          }
          // supported
          const candidates = projection.candidates;
          return (
            <div key={target} className="grid gap-2 @xl:grid-cols-[minmax(0,1fr)_minmax(13rem,0.8fr)] @xl:items-center">
              <div className="min-w-0">
                <span className="typography-ui-label text-foreground">{label}</span>
              </div>
              <Select
                value={projection.selected}
                onValueChange={(value) => run(setWorkbenchReplacementSelection(
                  target,
                  value === '__builtin__' ? null : value,
                  scopeOverride,
                ))}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__builtin__">{t('settings.varin.extensions.workbench.builtin')}</SelectItem>
                  {candidates.map((candidate) => (
                    <SelectItem key={candidate.descriptor.id} value={candidate.descriptor.id}>
                      {candidate.descriptor.title ?? candidate.descriptor.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          );
        })}
      </div>

      <Dialog open={createOpen} onOpenChange={(open) => !profileBusy && setCreateOpen(open)}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>{t('settings.varin.extensions.workbench.createProfile')}</DialogTitle></DialogHeader>
          <Input
            autoFocus
            value={profileName}
            onChange={(event) => setProfileName(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') void createProfile(); }}
            placeholder={t('settings.varin.extensions.workbench.profileName')}
          />
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={profileBusy} onClick={() => setCreateOpen(false)}>
              {t('settings.common.actions.cancel')}
            </Button>
            <Button type="button" disabled={profileBusy || !profileName.trim()} onClick={() => { void createProfile(); }}>
              {t('settings.varin.extensions.workbench.createProfile')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={removeOpen} onOpenChange={(open) => !profileBusy && setRemoveOpen(open)}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>{t('settings.varin.extensions.workbench.removeProfileNamed', { name: workbenchProfileLabel(profile, t) })}</DialogTitle></DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={profileBusy} onClick={() => setRemoveOpen(false)}>
              {t('settings.common.actions.cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={profileBusy}
              onClick={() => {
                setProfileBusy(true);
                void removeWorkbenchProfile(profile.id).then(() => setRemoveOpen(false)).catch((error) => {
                  toast.error(error instanceof Error ? error.message : String(error));
                }).finally(() => setProfileBusy(false));
              }}
            >
              {t('settings.varin.extensions.workbench.removeProfile')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </SettingsSection>
  );
};

const serviceName = (serviceId: string): string => {
  const tail = serviceId.split('.').filter(Boolean).at(-1) ?? serviceId;
  return tail.replace(/[-_]+/g, ' ').replace(/\b\w/g, (value) => value.toUpperCase());
};

const ServiceRoutingSection: React.FC = () => {
  const { t } = useI18n();
  const catalog = useVarinExtensionCatalog();
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const [scopeKind, setScopeKind] = React.useState<'user' | 'workspace'>(currentDirectory ? 'workspace' : 'user');
  const [busyKey, setBusyKey] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!currentDirectory && scopeKind === 'workspace') setScopeKind('user');
  }, [currentDirectory, scopeKind]);
  const snapshot = catalog.snapshot;
  if (!snapshot?.routing.authoritative) return null;

  const providerGroups = serviceRoutingOptions(snapshot);
  const serviceKeys = new Set([
    ...[...providerGroups].filter(([, providers]) => providers.length > 1).map(([key]) => key),
    ...snapshot.routing.document.rules.map((rule) => `${rule.serviceId}@${rule.version}`),
  ]);
  if (serviceKeys.size === 0) return null;

  const editableScope = scopeKind === 'workspace' && currentDirectory
    ? { workspaceId: currentDirectory }
    : { userId: 'default' };
  const routingContext = currentDirectory
    ? { userId: 'default', workspaceId: currentDirectory }
    : { userId: 'default' };
  const editableScopeKey = serviceRoutingScopeKey(editableScope);
  const extensionNames = new Map(snapshot.catalog.extensions.map((entry) => [
    entry.manifest.id,
    workbenchExtensionDisplayName(entry, t),
  ]));

  const selectProvider = async (
    serviceId: string,
    version: number,
    providerKey: string | null,
  ): Promise<void> => {
    const key = `${serviceId}@${version}`;
    setBusyKey(key);
    try {
      await setVarinExtensionServiceRoute(serviceId, version, editableScope, providerKey);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyKey((current) => current === key ? null : current);
    }
  };

  return (
    <SettingsSection title={t('settings.varin.extensions.routing.title')} settingsItem="extensions.routing">
      <div className="space-y-3">
        <div className="flex justify-end">
          <Select
            value={scopeKind}
            onValueChange={(value) => setScopeKind(value === 'workspace' ? 'workspace' : 'user')}
          >
            <SelectTrigger className="w-full @xl:w-56"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="user">{t('settings.varin.extensions.routing.scope.user')}</SelectItem>
              <SelectItem value="workspace" disabled={!currentDirectory}>
                {t('settings.varin.extensions.routing.scope.workspace')}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        {[...serviceKeys].sort().map((key) => {
          const separator = key.lastIndexOf('@');
          const id = key.slice(0, separator);
          const version = Number(key.slice(separator + 1));
          const providers = providerGroups.get(key) ?? [];
          const exactRule = snapshot.routing.document.rules.find((rule) => (
            rule.serviceId === id
            && rule.version === version
            && serviceRoutingScopeKey(rule.scope) === editableScopeKey
          ));
          const selected = exactRule?.providerKey ?? '__automatic__';
          const selectedMissing = selected !== '__automatic__'
            && !providers.some((provider) => provider.providerKey === selected);
          const resolution = resolveVarinExtensionServiceRouting({
            // The pure resolver uses an opaque candidate identity. A declared option has no
            // executable generation yet; selecting its stable key asks the Host to prepare it.
            candidates: providers.map((provider) => ({ providerId: provider.providerId ?? provider.providerKey, providerKey: provider.providerKey })),
            context: routingContext,
            document: snapshot.routing.document,
            serviceId: id,
            version,
            ...(id === VARIN_RETRIEVAL_PLAN_SERVICE_ID && version === VARIN_RETRIEVAL_PLAN_VERSION
              ? { defaultProviderKey: VARIN_BUILTIN_RETRIEVAL_DEFAULT_PROVIDER_KEY } : {}),
          });
          const resolved = providers.find((provider) => provider.providerKey === resolution.providerKey);
          return (
            <div key={key} className="grid gap-2 rounded-lg border border-border/60 px-3 py-3 @xl:grid-cols-[minmax(0,1fr)_minmax(14rem,0.8fr)] @xl:items-center">
              <div className="min-w-0">
                <div className="typography-ui-label text-foreground">{id === VARIN_RETRIEVAL_PLAN_SERVICE_ID
                  ? t('settings.varin.extensions.routing.retrieval') : serviceName(id)}</div>
                <div className={resolution.status === 'resolved'
                  ? 'typography-micro text-muted-foreground'
                  : 'typography-micro text-[var(--status-warning)]'}>
                  {resolution.status === 'resolved'
                    ? t(resolved?.status === 'active' ? 'settings.varin.extensions.routing.status.ready' : 'settings.varin.extensions.routing.status.declared')
                    : resolution.status === 'ambiguous'
                      ? t('settings.varin.extensions.routing.status.choose')
                      : t('settings.varin.extensions.routing.status.unavailable')}
                </div>
              </div>
              <Select
                value={selected}
                disabled={busyKey === key}
                onValueChange={(value) => { void selectProvider(id, version, value === '__automatic__' ? null : value); }}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__automatic__">{t('settings.varin.extensions.routing.automatic')}</SelectItem>
                  {selectedMissing ? (
                    <SelectItem value={selected}>{t('settings.varin.extensions.routing.missing')}</SelectItem>
                  ) : null}
                  {providers.map((provider) => (
                    <SelectItem key={provider.providerKey} value={provider.providerKey}>
                      {extensionNames.get(provider.extensionId) ?? provider.extensionId}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          );
        })}
      </div>
    </SettingsSection>
  );
};

const ExtensionCard: React.FC<{
  busy: boolean;
  composition: ReturnType<typeof getWorkbenchCompositionInspectorSnapshot>;
  entry: VarinExtensionCatalogEntry;
  hostState: VarinExtensionHostStateSnapshot | null;
  surface: ReturnType<typeof useSurfaceRegistrySnapshot>;
}> = ({ busy, composition, entry, hostState, surface }) => {
  const { t } = useI18n();
  const [inspectOpen, setInspectOpen] = React.useState(false);
  const [removeOpen, setRemoveOpen] = React.useState(false);
  const [deleteData, setDeleteData] = React.useState(false);
  const status = actualStatus(entry);
  const candidate = entry.candidate;
  const selectedCapabilities: VarinExtensionCapabilityReference[] = (["host", "surface"] as const).flatMap((realm) => (
    (entry.manifest.capabilities?.[realm] ?? []).map((capability) => ({ capability, realm }))
  ));
  const selectedDecisions = new Map(entry.capabilityGrants
    .filter((grant) => grant.manifestVersion === entry.manifest.version)
    .map((grant) => [capabilityKey(grant), grant.granted]));
  const selectedCapabilitiesReviewed = entry.source.kind === 'builtin'
    || selectedCapabilities.every((reference) => selectedDecisions.has(capabilityKey(reference)));
  const liveContributions = surface.contributions.filter((item) => item.owner.extensionId === entry.manifest.id);
  const liveSurfaceServices = surface.services.filter((item) => item.owner.extensionId === entry.manifest.id);
  const liveHostServices = hostState?.services.providers.filter((item) => item.extensionId === entry.manifest.id) ?? [];
  const monacoServiceDeclared = (entry.manifest.requires?.services ?? []).some((service) => (
    service.id === VARIN_EDITOR_MONACO_SERVICE_ID
    && service.version === VARIN_EDITOR_MONACO_SERVICE_VERSION
  ));
  const catalogDiagnostics = hostState?.catalog.diagnostics.filter((item) => item.extensionId === entry.manifest.id) ?? [];
  const workspaceId = useWorkbenchWorkspaceId();
  const profileResolution = hostState?.workbench.authoritative && hostState.workbench.storageState === 'ready'
    ? resolveVarinWorkbenchProfile(hostState.workbench.document, hostState.catalog, {
      surface: varinSurfaceRuntime.surface,
      userId: 'default',
      ...(workspaceId ? { workspaceId } : {}),
    })
    : undefined;
  const ownsActiveShell = profileResolution?.shellExtensionId === entry.manifest.id;
  const shellSeamSummary = profileResolution ? describeWorkbenchShellSeams(
    profileResolution.shellContributionId,
    profileResolution.shellExtensionId,
    hostState?.catalog.extensions ?? [],
    varinSurfaceRuntime.surface,
  ) : null;
  const activeSeamProjection = profileResolution ? projectWorkbenchSeams({
    layout: profileResolution.layout,
    shellContributionId: profileResolution.shellContributionId,
    shellExtensionId: profileResolution.shellExtensionId,
    shellStatus: profileResolution.status,
    catalog: hostState?.catalog.extensions ?? [],
    surface: varinSurfaceRuntime.surface,
    visibleContributions: surface.contributions,
  }) : [];
  const dormantSeams = activeSeamProjection.filter((projection) => projection.status === 'dormant');
  const mountedShellChildren = composition.entries.filter((child) => (
    child.shellContributionId === profileResolution?.shellContributionId
  ));
  const documentOwner = entry.capabilityGrants.some((grant) => (
    workbenchInspectorOwnsDocuments(grant.capability) && grant.granted
  ));
  const languageOwner = liveHostServices.some((service) => workbenchInspectorOwnsLanguage(service.descriptor.id))
    || entry.capabilityGrants.some((grant) => grant.capability === 'workspace.language' && grant.granted);
  const debugOwner = liveHostServices.some((service) => workbenchInspectorOwnsRun(service.descriptor.id))
    || entry.capabilityGrants.some((grant) => (
      (workbenchInspectorOwnsDebugCapability(grant.capability) || workbenchInspectorOwnsTestCapability(grant.capability))
      && grant.granted
    ));
  const decisions = new Map(candidate?.capabilityGrants.map((grant) => [capabilityKey(grant), grant.granted]) ?? []);
  const review = async (reference: VarinExtensionCapabilityReference, granted: boolean): Promise<void> => {
    if (!candidate) return;
    await reviewVarinExtensionCandidateCapabilities({
      candidateIntegrity: candidate.integrity,
      decisions: [{ ...reference, granted }],
      extensionId: entry.manifest.id,
    });
  };
  const reviewSelected = async (reference: VarinExtensionCapabilityReference, granted: boolean): Promise<void> => {
    await reviewVarinExtensionCapabilities({
      decisions: [{ ...reference, granted }],
      extensionId: entry.manifest.id,
    });
  };

  return (
    <div className="rounded-lg border border-border/60 px-3 py-3">
      <div className="flex flex-col gap-3 @xl:flex-row @xl:items-start @xl:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Icon
              name="plug-2"
              className={status === 'active'
                ? 'size-4 text-[var(--status-success)]'
                : status === 'failed' || status === 'restart-required'
                  ? 'size-4 text-[var(--status-error)]'
                  : 'size-4 text-muted-foreground'}
            />
            <span className="typography-ui-label text-foreground">
              {workbenchExtensionDisplayName(entry, t)}
            </span>
            <span className="rounded-md bg-interactive-hover px-1.5 py-0.5 typography-micro text-muted-foreground">
              {t(STATUS_KEYS[status])}
            </span>
            <span className="typography-micro text-muted-foreground">v{entry.selectedVersion}</span>
          </div>
          <p className="break-all font-mono typography-micro text-muted-foreground">{entry.manifest.id}</p>
          <p className="break-all typography-micro text-muted-foreground/80">
            {entry.source.display} · {entry.source.kind}
          </p>
        </div>
        <Switch
          checked={entry.desired.enabled}
          disabled={busy || (!entry.desired.enabled && !selectedCapabilitiesReviewed)}
          onCheckedChange={(enabled) => {
            void setVarinExtensionEnabled(entry.manifest.id, enabled).catch(() => undefined);
          }}
          aria-label={t('settings.varin.extensions.actions.activationAria', {
            name: workbenchExtensionDisplayName(entry, t),
          })}
        />
      </div>

      {entry.source.kind !== 'builtin' && !entry.desired.enabled && selectedCapabilities.length > 0 ? (
        <div className="mt-3 border-t border-border/50 pt-3">
          <div className="mb-2 typography-ui-label text-foreground">
            {t('settings.varin.extensions.inspector.capabilities')}
          </div>
          <div className="space-y-2">
            {selectedCapabilities.map((reference) => {
              const key = capabilityKey(reference);
              const decision = selectedDecisions.get(key);
              return (
                <div key={key} className="flex flex-col gap-2 rounded-md bg-interactive-hover px-2.5 py-2 @xl:flex-row @xl:items-center @xl:justify-between">
                  <code className="break-all typography-micro">{key}</code>
                  <div className="flex shrink-0 gap-2">
                    <Button
                      type="button"
                      variant={decision === false ? 'secondary' : 'outline'}
                      size="xs"
                      disabled={busy}
                      onClick={() => { void reviewSelected(reference, false).catch(() => undefined); }}
                    >
                      {t('settings.varin.extensions.candidate.deny')}
                    </Button>
                    <Button
                      type="button"
                      variant={decision === true ? 'secondary' : 'outline'}
                      size="xs"
                      disabled={busy}
                      onClick={() => { void reviewSelected(reference, true).catch(() => undefined); }}
                    >
                      {t('settings.varin.extensions.candidate.allow')}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {candidate ? (
        <div className="mt-3 border-t border-border/50 pt-3">
          <div className="flex flex-wrap items-center gap-2 typography-meta">
            <span className="font-medium text-foreground">
              {t('settings.varin.extensions.candidate.title', { version: candidate.resolvedVersion })}
            </span>
            {candidate.capabilitiesReviewed ? (
              <span className="text-[var(--status-success)]">
                {t('settings.varin.extensions.candidate.reviewed')}
              </span>
            ) : null}
          </div>
          {candidate.capabilityDelta.added.length > 0 ? (
            <div className="mt-2 space-y-2">
              {candidate.capabilityDelta.added.map((reference) => {
                const key = capabilityKey(reference);
                const decision = decisions.get(key);
                return (
                  <div key={key} className="flex flex-col gap-2 rounded-md bg-interactive-hover px-2.5 py-2 @xl:flex-row @xl:items-center @xl:justify-between">
                    <code className="break-all typography-micro">{key}</code>
                    <div className="flex shrink-0 gap-2">
                      <Button
                        type="button"
                        variant={decision === false ? 'secondary' : 'outline'}
                        size="xs"
                        disabled={busy}
                        onClick={() => { void review(reference, false).catch(() => undefined); }}
                      >
                        {t('settings.varin.extensions.candidate.deny')}
                      </Button>
                      <Button
                        type="button"
                        variant={decision === true ? 'secondary' : 'outline'}
                        size="xs"
                        disabled={busy}
                        onClick={() => { void review(reference, true).catch(() => undefined); }}
                      >
                        {t('settings.varin.extensions.candidate.allow')}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={busy}
              onClick={() => {
                void discardVarinExtensionCandidate(entry.manifest.id, candidate.integrity).catch(() => undefined);
              }}
            >
              {t('settings.varin.extensions.candidate.discard')}
            </Button>
            <Button
              type="button"
              size="xs"
              disabled={busy || !candidate.capabilitiesReviewed || candidate.applyRequested}
              onClick={() => {
                void selectVarinExtensionCandidate(entry.manifest.id, candidate.integrity).catch(() => undefined);
              }}
            >
              {t('settings.varin.extensions.candidate.apply')}
            </Button>
          </div>
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap justify-end gap-2 border-t border-border/50 pt-3">
        {entry.source.kind === 'local' ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={busy}
            onClick={() => { void reloadVarinExtensionLocalSource(entry.manifest.id).catch(() => undefined); }}
          >
            {t('settings.varin.extensions.actions.reloadLocal')}
          </Button>
        ) : null}
        <Button type="button" variant="ghost" size="xs" onClick={() => setInspectOpen(true)}>
          {t('settings.varin.extensions.actions.inspect')}
        </Button>
        {entry.source.kind !== 'builtin' ? (
          <Button type="button" variant="ghost" size="xs" disabled={busy} onClick={() => {
            setDeleteData(false);
            setRemoveOpen(true);
          }}>
            {t('settings.varin.extensions.actions.remove')}
          </Button>
        ) : null}
      </div>

      <Dialog open={inspectOpen} onOpenChange={setInspectOpen}>
        <DialogContent className="max-h-[min(80vh,48rem)] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{workbenchExtensionDisplayName(entry, t)}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 @xl:grid-cols-2">
            <div className="space-y-2">
              <div className="typography-ui-label text-foreground">{t('settings.varin.extensions.inspector.runtime')}</div>
              <div className="space-y-1 typography-micro text-muted-foreground">
                <div>{t('settings.varin.extensions.inspector.version')}: {entry.selectedVersion}</div>
                <div>{t('settings.varin.extensions.inspector.source')}: {entry.source.kind} · {entry.source.display}</div>
                <div>{t('settings.varin.extensions.inspector.integrity')}: {entry.integrity ?? '—'}</div>
              </div>
              {entry.actual.length > 0 ? (
                <div className="space-y-1">
                  {entry.actual.map((actual) => (
                    <div key={`${actual.realmKind}:${actual.realmId}:${actual.entrypointId}`} className="rounded-md bg-interactive-hover px-2.5 py-2 typography-micro">
                      <div className="text-foreground">{actual.realmKind} · {actual.entrypointId} · {t(STATUS_KEYS[actual.status])}</div>
                      <div className="text-muted-foreground">{actual.realmId} · #{actual.generation} · {actual.updatedAt}</div>
                      {actual.diagnostics.map((diagnostic) => (
                        <div key={`${diagnostic.code}:${diagnostic.timestamp}`} className="mt-1 text-[var(--status-warning)]">
                          {diagnostic.message}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              ) : <div className="typography-micro text-muted-foreground">{t('settings.varin.extensions.inspector.noRealms')}</div>}
              {catalogDiagnostics.length > 0 ? (
                <div className="space-y-1">
                  <div className="typography-ui-label text-foreground">{t('settings.varin.extensions.inspector.diagnostics')}</div>
                  {catalogDiagnostics.map((diagnostic) => (
                    <div key={`${diagnostic.code}:${diagnostic.timestamp}`} className="rounded-md bg-interactive-hover px-2.5 py-2 typography-micro text-muted-foreground">
                      <div className="text-foreground">{diagnostic.code} · {diagnostic.severity}</div>
                      <div>{diagnostic.message}</div>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="space-y-3">
              <div>
                <div className="typography-ui-label text-foreground">{t('settings.varin.extensions.inspector.artifacts')}</div>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {entry.manifest.entrypoints?.host ? (
                    <code className="rounded bg-interactive-hover px-1.5 py-1 typography-micro">host · {entry.manifest.entrypoints.host.mode} · {entry.manifest.entrypoints.host.file}</code>
                  ) : null}
                  {(entry.manifest.entrypoints?.surfaces ?? []).map((surface) => (
                    <code key={surface.id} className="rounded bg-interactive-hover px-1.5 py-1 typography-micro">
                      {surface.id} · {surface.mode}{surface.file ? ` · ${surface.file}` : ''}
                    </code>
                  ))}
                  {!entry.manifest.entrypoints?.host && (entry.manifest.entrypoints?.surfaces ?? []).length === 0 ? '—' : null}
                </div>
              </div>
              <div>
                <div className="typography-ui-label text-foreground">{t('settings.varin.extensions.inspector.activeShell')}</div>
                <div className="mt-1 typography-micro text-muted-foreground">
                  {ownsActiveShell
                    ? t('settings.varin.extensions.inspector.ownsActiveShell')
                    : profileResolution?.shellContributionId
                      ? t('settings.varin.extensions.inspector.activeShellId', { id: profileResolution.shellContributionId })
                      : t('settings.varin.extensions.inspector.none')}
                </div>
                {ownsActiveShell && shellSeamSummary ? (
                  <div className="mt-2 space-y-1 typography-micro text-muted-foreground">
                    {shellSeamSummary.contractIssues.map((issue) => (
                      <div key={`contract-issue:${issue}`} className="text-[color:var(--status-error)]">{issue}</div>
                    ))}
                    {shellSeamSummary.declaredReplacementTargets.map((target) => (
                      <div key={`declared-target:${target}`}>
                        {t('settings.varin.extensions.inspector.replaces', { target })}
                      </div>
                    ))}
                    {shellSeamSummary.declaredSlots.map((slot) => (
                      <div key={`declared-slot:${slot}`}>
                        {t('settings.varin.extensions.inspector.slot', { slot })}
                      </div>
                    ))}
                    {dormantSeams.map((seam) => (
                      <div key={`dormant:${seam.target}`}>
                        {t('settings.varin.extensions.workbench.dormant')} · {seam.target} · {seam.selected}
                      </div>
                    ))}
                    {mountedShellChildren.map((child) => (
                      <div key={`${child.host}:${child.hostId}:${child.contributionId}:${child.generation}`}>
                        {child.host} · {child.hostId} · {child.contributionId}
                        {` · ${t('settings.varin.extensions.inspector.cleanup')} #${child.generation}`}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
              <div>
                <div className="typography-ui-label text-foreground">{t('settings.varin.extensions.inspector.contributions')}</div>
                <div className="mt-1 space-y-1">
                  {(entry.manifest.contributions ?? []).map((contribution) => {
                    const described = describeWorkbenchContributionPlacement(contribution);
                    const live = liveContributions.some((item) => item.descriptor.id === contribution.id);
                    return (
                      <div key={contribution.id} className="break-all typography-micro text-muted-foreground">
                        {contribution.title ?? contribution.id} · {contribution.kind} · {live
                          ? t('settings.varin.extensions.status.active')
                          : t('settings.varin.extensions.status.inactive')}
                        {described.placement ? ` · ${t('settings.varin.extensions.inspector.slot', { slot: described.placement })}` : ''}
                        {described.replacement ? ` · ${t('settings.varin.extensions.inspector.replaces', { target: described.replacement })}` : ''}
                      </div>
                    );
                  })}
                  {liveContributions.filter((item) => !(entry.manifest.contributions ?? []).some((declared) => declared.id === item.descriptor.id)).map((item) => {
                    const described = describeWorkbenchContributionPlacement(item.descriptor);
                    return (
                      <div key={item.descriptor.id} className="break-all typography-micro text-muted-foreground">
                        {item.descriptor.title ?? item.descriptor.id} · {item.descriptor.kind} · {t('settings.varin.extensions.status.active')}
                        {described.placement ? ` · ${t('settings.varin.extensions.inspector.slot', { slot: described.placement })}` : ''}
                        {described.replacement ? ` · ${t('settings.varin.extensions.inspector.replaces', { target: described.replacement })}` : ''}
                        {` · ${t('settings.varin.extensions.inspector.cleanup')} #${item.owner.generation}`}
                      </div>
                    );
                  })}
                  {(entry.manifest.contributions ?? []).length === 0 && liveContributions.length === 0 ? <span className="typography-micro text-muted-foreground">—</span> : null}
                </div>
              </div>
              <div>
                <div className="typography-ui-label text-foreground">{t('settings.varin.extensions.inspector.documentOwner')}</div>
                <div className="mt-1 typography-micro text-muted-foreground">
                  {documentOwner ? t('settings.varin.extensions.status.active') : t('settings.varin.extensions.inspector.none')}
                </div>
              </div>
              <div>
                <div className="typography-ui-label text-foreground">{t('settings.varin.extensions.inspector.languageOwner')}</div>
                <div className="mt-1 typography-micro text-muted-foreground">
                  {languageOwner ? t('settings.varin.extensions.status.active') : t('settings.varin.extensions.inspector.none')}
                </div>
              </div>
              <div>
                <div className="typography-ui-label text-foreground">{t('settings.varin.extensions.inspector.debugOwner')}</div>
                <div className="mt-1 typography-micro text-muted-foreground">
                  {debugOwner ? t('settings.varin.extensions.status.active') : t('settings.varin.extensions.inspector.none')}
                </div>
              </div>
              <div>
                <div className="typography-ui-label text-foreground">{t('settings.varin.extensions.inspector.services')}</div>
                <div className="mt-1 space-y-1">
                  {liveHostServices.map((service) => (
                    <div key={service.providerId} className="break-all typography-micro text-muted-foreground">
                      host · {service.descriptor.id}@{service.descriptor.version} · {service.status}
                    </div>
                  ))}
                  {liveSurfaceServices.map((service) => (
                    <div key={`${service.owner.realmId}:${service.descriptor.id}@${service.descriptor.version}`} className="break-all typography-micro text-muted-foreground">
                      surface · {service.descriptor.id}@{service.descriptor.version} · {t('settings.varin.extensions.status.active')}
                    </div>
                  ))}
                  <MonacoServiceInspectorRows
                    declared={monacoServiceDeclared}
                    extensionId={entry.manifest.id}
                    hasOtherServices={liveHostServices.length > 0 || liveSurfaceServices.length > 0}
                  />
                </div>
              </div>
              <div>
                <div className="typography-ui-label text-foreground">{t('settings.varin.extensions.inspector.dependencies')}</div>
                <div className="mt-1 space-y-1">
                  {(entry.manifest.requires?.services ?? []).map((service) => (
                    <div key={`${service.id}@${service.version}`} className="break-all typography-micro text-muted-foreground">
                      {service.id}@{service.version}{service.optional ? ` · ${t('settings.varin.extensions.inspector.optional')}` : ''}
                    </div>
                  ))}
                  {(entry.manifest.integrates?.piPackages ?? []).map((packageName) => (
                    <div key={packageName} className="break-all typography-micro text-muted-foreground">Pi · {packageName}</div>
                  ))}
                  {(entry.manifest.requires?.services ?? []).length === 0 && (entry.manifest.integrates?.piPackages ?? []).length === 0
                    ? <span className="typography-micro text-muted-foreground">—</span>
                    : null}
                </div>
              </div>
              <div>
                <div className="typography-ui-label text-foreground">{t('settings.varin.extensions.inspector.capabilities')}</div>
                <div className="mt-1 space-y-1">
                  {entry.capabilityGrants.map((grant) => (
                    <div key={`${grant.realm}:${grant.capability}`} className="break-all typography-micro text-muted-foreground">
                      {grant.realm}:{grant.capability} · {grant.granted
                        ? t('settings.varin.extensions.candidate.allow')
                        : t('settings.varin.extensions.candidate.deny')}
                    </div>
                  ))}
                  {entry.capabilityGrants.length === 0 ? <span className="typography-micro text-muted-foreground">—</span> : null}
                </div>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={removeOpen} onOpenChange={(open) => {
        if (busy) return;
        setRemoveOpen(open);
        if (!open) setDeleteData(false);
      }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('settings.varin.extensions.remove.title', {
              name: workbenchExtensionDisplayName(entry, t),
            })}</DialogTitle>
            <DialogDescription>{t('settings.varin.extensions.remove.storageScope')}</DialogDescription>
          </DialogHeader>
          <SettingsRadioGroup aria-label={t('settings.varin.extensions.remove.dataChoice')}>
            <SettingsRadioOption
              selected={!deleteData}
              onSelect={() => setDeleteData(false)}
              label={t('settings.varin.extensions.remove.retainData')}
              description={t('settings.varin.extensions.remove.retainDataDescription')}
              ariaLabel={t('settings.varin.extensions.remove.retainData')}
              disabled={busy}
            />
            <SettingsRadioOption
              selected={deleteData}
              onSelect={() => setDeleteData(true)}
              label={t('settings.varin.extensions.remove.deleteData')}
              description={t('settings.varin.extensions.remove.deleteDataDescription')}
              ariaLabel={t('settings.varin.extensions.remove.deleteData')}
              disabled={busy}
            />
          </SettingsRadioGroup>
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => setRemoveOpen(false)}>
              {t('settings.common.actions.cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={() => {
                void removeVarinExtension(entry.manifest.id, deleteData).then(() => setRemoveOpen(false)).catch(() => undefined);
              }}
            >
              {t('settings.varin.extensions.actions.remove')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

const ExtensionInstallSection: React.FC = () => {
  const { t } = useI18n();
  const state = useVarinExtensionCatalog();
  const [kind, setKind] = React.useState<'git' | 'local' | 'npm'>('npm');
  const [specifier, setSpecifier] = React.useState('');
  const install = async (): Promise<void> => {
    const normalized = specifier.trim();
    if (!normalized) return;
    try {
      await installVarinExtension({ display: normalized, kind, specifier: normalized });
      setSpecifier('');
    } catch {
      // The catalog store owns the visible error state.
    }
  };
  return (
    <SettingsSection title={t('settings.varin.extensions.install.title')} settingsItem="extensions.install">
      <div className="grid gap-2 @xl:grid-cols-[11rem_minmax(0,1fr)_auto]">
        <Select value={kind} onValueChange={(value) => setKind(value === 'git' || value === 'local' ? value : 'npm')}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="npm">npm</SelectItem>
            <SelectItem value="git">Git</SelectItem>
            <SelectItem value="local">{t('settings.varin.extensions.install.local')}</SelectItem>
          </SelectContent>
        </Select>
        <Input
          value={specifier}
          onChange={(event) => setSpecifier(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') void install(); }}
          placeholder={t('settings.varin.extensions.install.placeholder')}
        />
        <Button
          type="button"
          disabled={!specifier.trim() || state.busyExtensionId === '__install__'}
          onClick={() => { void install(); }}
        >
          {state.busyExtensionId === '__install__' ? <Icon name="loader-4" className="size-4 animate-spin" /> : null}
          {t('settings.varin.extensions.install.action')}
        </Button>
      </div>
    </SettingsSection>
  );
};

export const ExtensionsPage: React.FC = () => {
  const { t } = useI18n();
  const state = useVarinExtensionCatalog();
  const surface = useSurfaceRegistrySnapshot();
  const composition = React.useSyncExternalStore(
    subscribeWorkbenchCompositionInspector,
    getWorkbenchCompositionInspectorSnapshot,
    getWorkbenchCompositionInspectorSnapshot,
  );
  const extensions = state.snapshot?.catalog.extensions ?? [];
  const hostDiagnostics = [
    ...(state.snapshot?.catalog.diagnostics ?? []),
    ...(state.snapshot?.routing.diagnostics ?? []),
    ...(state.snapshot?.workbench.diagnostics ?? []),
  ];
  return (
    <SettingsPageLayout
      title={t('settings.page.extensions.title')}
      headerEnd={(
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={state.loading}
          onClick={() => { void refreshVarinExtensionCatalog().catch(() => undefined); }}
        >
          <Icon name="refresh" className={state.loading ? 'size-4 animate-spin' : 'size-4'} />
          {t('settings.varin.extensions.actions.refresh')}
        </Button>
      )}
      showSaveStatus={false}
    >
      <SettingsSection divider={false} settingsItem="extensions.catalog">
        {state.error ? (
          <div className="mb-3 rounded-lg border border-[color-mix(in_srgb,var(--status-error)_24%,transparent)] bg-[color-mix(in_srgb,var(--status-error)_7%,transparent)] px-3 py-2 typography-meta text-[var(--status-error)]">
            {state.error}
          </div>
        ) : null}
        {hostDiagnostics.map((diagnostic, index) => (
          <div
            key={`${diagnostic.code}:${diagnostic.timestamp}:${diagnostic.message}:${index}`}
            className={diagnostic.severity === 'error'
              ? 'mb-3 rounded-lg border border-[color-mix(in_srgb,var(--status-error)_24%,transparent)] bg-[color-mix(in_srgb,var(--status-error)_7%,transparent)] px-3 py-2 typography-meta text-[var(--status-error)]'
              : 'mb-3 rounded-lg border border-[color-mix(in_srgb,var(--status-warning)_24%,transparent)] bg-[color-mix(in_srgb,var(--status-warning)_7%,transparent)] px-3 py-2 typography-meta text-[var(--status-warning)]'}
          >
            <span className="font-medium">{diagnostic.code}</span> · {diagnostic.message}
          </div>
        ))}
        <div className="space-y-2">
          {extensions.map((entry) => (
            <ExtensionCard
              key={entry.manifest.id}
              composition={composition}
              entry={entry}
              hostState={state.snapshot}
              surface={surface}
              busy={state.busyExtensionId === entry.manifest.id}
            />
          ))}
        </div>
        {state.snapshot?.catalog.authoritative && extensions.length === 0 && !state.loading ? (
          <div className="rounded-lg border border-dashed border-border/60 px-4 py-8 text-center typography-ui text-muted-foreground">
            {t('settings.varin.extensions.empty')}
          </div>
        ) : null}
      </SettingsSection>
      <ExtensionInstallSection />
      <ServiceRoutingSection />
      <WorkbenchProfileSection />
    </SettingsPageLayout>
  );
};
