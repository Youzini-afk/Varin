import React from 'react';
import type {
  RecoveryStorageLocation,
  RecoveryStorageMode,
  RecoveryStorageStatus,
  RecoveryStorageWorkspaceSummary,
  RecoveryRetentionPolicy,
  WorkspaceRecoveryStatus,
} from '@varin/extension-contract';
import type { RecoveryPreference } from '@varin/protocol';
import { Icon } from '@/components/icon/Icon';
import { DirectoryExplorerDialog } from '@/components/session/DirectoryExplorerDialog';
import {
  SettingsRadioGroup,
  SettingsRadioOption,
  SettingsSection,
} from '@/components/sections/shared/SettingsSection';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { canRequestNativeDirectoryAccess, requestDirectoryAccess } from '@/lib/desktop';
import { updateDesktopSettings } from '@/lib/persistence';
import {
  getWorkspaceRecoveryAPI,
  requireWorkspaceRecoveryResult,
} from '@/lib/recovery/workspaceRecovery';
import { cn } from '@/lib/utils';
import { formatWorkspaceArchiveBytes } from '@/lib/workspaceArchive';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { useUIStore } from '@/stores/useUIStore';

const RECOVERY_PREFERENCES: Array<{
  descriptionKey: I18nKey;
  labelKey: I18nKey;
  value: RecoveryPreference;
}> = [
  {
    value: 'conversation',
    labelKey: 'settings.varin.recovery.preference.conversation.label',
    descriptionKey: 'settings.varin.recovery.preference.conversation.description',
  },
  {
    value: 'both',
    labelKey: 'settings.varin.recovery.preference.both.label',
    descriptionKey: 'settings.varin.recovery.preference.both.description',
  },
  {
    value: 'ask',
    labelKey: 'settings.varin.recovery.preference.ask.label',
    descriptionKey: 'settings.varin.recovery.preference.ask.description',
  },
];

const STORAGE_MODES: Array<{ labelKey: I18nKey; mode: RecoveryStorageMode }> = [
  { mode: 'application-data', labelKey: 'settings.varin.recovery.storage.applicationData' },
  { mode: 'workspace-local', labelKey: 'settings.varin.recovery.storage.workspaceLocal' },
  { mode: 'workspace-adjacent', labelKey: 'settings.varin.recovery.storage.workspaceAdjacent' },
  { mode: 'custom', labelKey: 'settings.varin.recovery.storage.custom' },
];

type StorageEditorMode = RecoveryStorageMode | 'inherit';
type StoragePickerTarget = 'global' | 'workspace';
type RetentionDraft = {
  maxAgeDays: string;
  maxByteLengthMiB: string;
  maxCheckpointCount: string;
  maxOperationCount: string;
};

const retentionDraft = (policy?: RecoveryRetentionPolicy): RetentionDraft => ({
  maxAgeDays: policy?.maxAgeDays === null || policy?.maxAgeDays === undefined ? '' : String(policy.maxAgeDays),
  maxByteLengthMiB: policy?.maxByteLength === null || policy?.maxByteLength === undefined
    ? ''
    : String(policy.maxByteLength / 1_048_576),
  maxCheckpointCount: policy?.maxCheckpointCount === null || policy?.maxCheckpointCount === undefined
    ? ''
    : String(policy.maxCheckpointCount),
  maxOperationCount: policy?.maxOperationCount === null || policy?.maxOperationCount === undefined
    ? ''
    : String(policy.maxOperationCount),
});

const parseRetentionCount = (value: string, errorMessage: string): number | null => {
  if (!value.trim()) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(errorMessage);
  return parsed;
};

const parseRetentionMiB = (value: string, errorMessage: string): number | null => {
  if (!value.trim()) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(errorMessage);
  const bytes = Math.round(parsed * 1_048_576);
  if (!Number.isSafeInteger(bytes)) throw new Error(errorMessage);
  return bytes;
};

const storageLocation = (mode: RecoveryStorageMode, customRoot: string): RecoveryStorageLocation => (
  mode === 'custom' ? { customRoot: customRoot.trim(), mode } : { mode }
);

const statusTone = (state: RecoveryStorageStatus['state']): string => {
  if (state === 'ready') return 'text-[var(--status-success)]';
  if (state === 'missing') return 'text-muted-foreground';
  if (state === 'incomplete') return 'text-[var(--status-warning)]';
  return 'text-[var(--status-error)]';
};

export const RecoverySettings: React.FC = () => {
  const { t } = useI18n();
  const preference = useUIStore((state) => state.recoveryPreference);
  const setPreference = useUIStore((state) => state.setRecoveryPreference);
  const workspaceId = usePiSessionStore((state) => {
    const sessionId = state.currentSessionId;
    const workspace = sessionId ? state.records[sessionId]?.snapshot?.workspace : undefined;
    return workspace?.kind === 'workspace' ? workspace.authorityId ?? workspace.id : null;
  });
  const [globalStatus, setGlobalStatus] = React.useState<RecoveryStorageStatus | null>(null);
  const [storageWorkspaces, setStorageWorkspaces] = React.useState<RecoveryStorageWorkspaceSummary[]>([]);
  const [status, setStatus] = React.useState<WorkspaceRecoveryStatus | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [busy, setBusy] = React.useState<'cleanup' | 'delete' | 'global' | 'move' | 'retention' | null>(null);
  const [globalError, setGlobalError] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [globalStorageMode, setGlobalStorageMode] = React.useState<RecoveryStorageMode>('application-data');
  const [globalCustomRoot, setGlobalCustomRoot] = React.useState('');
  const [storageMode, setStorageMode] = React.useState<StorageEditorMode>('inherit');
  const [customRoot, setCustomRoot] = React.useState('');
  const [pickerTarget, setPickerTarget] = React.useState<StoragePickerTarget | null>(null);
  const [maintenanceBusy, setMaintenanceBusy] = React.useState<string | null>(null);
  const [maintenanceError, setMaintenanceError] = React.useState<string | null>(null);
  const [retention, setRetention] = React.useState<RetentionDraft>(() => retentionDraft());

  const changePreference = React.useCallback((next: RecoveryPreference) => {
    setPreference(next);
    void updateDesktopSettings({ recoveryPreference: next });
  }, [setPreference]);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    setGlobalError(null);
    setMaintenanceError(null);
    setError(null);
    try {
      const api = getWorkspaceRecoveryAPI();
      const [globalResult, workspaceResult, inventoryResult] = await Promise.allSettled([
        api.storageStatus().then(requireWorkspaceRecoveryResult),
        workspaceId
          ? api.status(workspaceId).then(requireWorkspaceRecoveryResult)
          : Promise.resolve(null),
        api.listStorageWorkspaces().then(requireWorkspaceRecoveryResult),
      ]);
      if (globalResult.status === 'fulfilled') {
        const next = globalResult.value.storage;
        setGlobalStatus(next);
        setGlobalStorageMode(next.location.mode);
        setGlobalCustomRoot(next.location.mode === 'custom' ? next.location.customRoot : '');
      } else {
        setGlobalStatus(null);
        setGlobalError(globalResult.reason instanceof Error ? globalResult.reason.message : String(globalResult.reason));
      }
      if (workspaceResult.status === 'fulfilled') {
        const next = workspaceResult.value;
        setStatus(next);
        if (next) {
          setRetention(retentionDraft(next.retention.policy));
          setStorageMode(next.storage.locationSource === 'workspace' ? next.storage.location.mode : 'inherit');
          setCustomRoot(
            next.storage.locationSource === 'workspace' && next.storage.location.mode === 'custom'
              ? next.storage.location.customRoot
              : '',
          );
        } else {
          setRetention(retentionDraft());
          setStorageMode('inherit');
          setCustomRoot('');
        }
      } else {
        setStatus(null);
        setRetention(retentionDraft());
        setError(workspaceResult.reason instanceof Error ? workspaceResult.reason.message : String(workspaceResult.reason));
      }
      if (inventoryResult.status === 'fulfilled') {
        setStorageWorkspaces(inventoryResult.value.workspaces);
      } else {
        setStorageWorkspaces([]);
        setMaintenanceError(inventoryResult.reason instanceof Error
          ? inventoryResult.reason.message
          : String(inventoryResult.reason));
      }
    } catch (cause) {
      setGlobalStatus(null);
      setStorageWorkspaces([]);
      setStatus(null);
      setGlobalError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const saveGlobalStorage = React.useCallback(async () => {
    if (globalStorageMode === 'custom' && !globalCustomRoot.trim()) return;
    setBusy('global');
    try {
      requireWorkspaceRecoveryResult(
        await getWorkspaceRecoveryAPI().setDefaultStorageLocation(
          storageLocation(globalStorageMode, globalCustomRoot),
        ),
      );
      toast.success(t('settings.varin.recovery.storage.globalSaved'));
      await refresh();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }, [globalCustomRoot, globalStorageMode, refresh, t]);

  const moveStorage = React.useCallback(async () => {
    if (!workspaceId || (storageMode === 'custom' && !customRoot.trim())) return;
    setBusy('move');
    try {
      const api = getWorkspaceRecoveryAPI();
      if (storageMode === 'inherit') {
        requireWorkspaceRecoveryResult(await api.clearStorageLocationOverride(workspaceId));
      } else {
        requireWorkspaceRecoveryResult(await api.setStorageLocation({
          location: storageLocation(storageMode, customRoot),
          workspaceId,
        }));
      }
      toast.success(t('settings.varin.recovery.storage.moveComplete'));
      await refresh();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }, [customRoot, refresh, storageMode, t, workspaceId]);

  const chooseStorageFolder = React.useCallback(async (target: StoragePickerTarget) => {
    const currentPath = target === 'global' ? globalCustomRoot : customRoot;
    if (canRequestNativeDirectoryAccess()) {
      const selected = await requestDirectoryAccess(currentPath, {
        title: t('settings.varin.recovery.storage.folderPickerTitle'),
      });
      if (selected.success && selected.path) {
        if (target === 'global') setGlobalCustomRoot(selected.path);
        else setCustomRoot(selected.path);
      }
      return;
    }
    setPickerTarget(target);
  }, [customRoot, globalCustomRoot, t]);

  const maintainStorageWorkspaces = React.useCallback(async (
    action: 'cleanup' | 'migrate',
    targets: RecoveryStorageWorkspaceSummary[],
  ) => {
    if (targets.length === 0) return;
    setMaintenanceBusy(`${action}:${targets.length === 1 ? targets[0].workspaceId : 'all'}`);
    setMaintenanceError(null);
    try {
      const api = getWorkspaceRecoveryAPI();
      const results = await Promise.allSettled(targets.map(async (workspace) => {
        if (action === 'migrate') {
          const moved = requireWorkspaceRecoveryResult(
            await api.clearStorageLocationOverride(workspace.workspaceId),
          );
          if (moved.operation.state !== 'complete') {
            throw new Error(moved.operation.failure?.message || t('settings.varin.recovery.storage.maintenanceFailed'));
          }
          return 0;
        }
        const cleaned = requireWorkspaceRecoveryResult(
          await api.cleanupStorage({ workspaceId: workspace.workspaceId }),
        );
        if (cleaned.result.status !== 'complete') {
          throw new Error(cleaned.result.failures[0]?.message || t('settings.varin.recovery.storage.maintenanceFailed'));
        }
        return cleaned.result.byteLengthReclaimed;
      }));
      const failed = results.filter((result) => result.status === 'rejected');
      if (failed.length > 0) {
        const first = failed[0].status === 'rejected' ? failed[0].reason : null;
        const summary = t('settings.varin.recovery.storage.maintenancePartial', {
          failed: failed.length,
          total: targets.length,
        });
        const detail = first instanceof Error ? first.message : first ? String(first) : '';
        throw new Error(detail ? `${summary}: ${detail}` : summary, { cause: first });
      }
      const reclaimedBytes = results.reduce((total, result) => (
        result.status === 'fulfilled' ? total + result.value : total
      ), 0);
      toast.success(t(
        action === 'migrate'
          ? 'settings.varin.recovery.storage.migrateComplete'
          : reclaimedBytes === 0
            ? 'settings.varin.recovery.storage.cleanupNothing'
            : 'settings.varin.recovery.storage.cleanupAllComplete',
        { bytes: formatWorkspaceArchiveBytes(reclaimedBytes), count: targets.length },
      ));
      await refresh();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setMaintenanceError(message);
      toast.error(message);
    } finally {
      setMaintenanceBusy(null);
    }
  }, [refresh, t]);

  const deleteStoredWorkspaceHistory = React.useCallback(async (workspace: RecoveryStorageWorkspaceSummary) => {
    if (typeof window === 'undefined'
      || !window.confirm(t('settings.varin.recovery.storage.deleteStoredConfirm', {
        path: workspace.canonicalRoot,
      }))) return;
    setMaintenanceBusy(`delete:${workspace.workspaceId}`);
    setMaintenanceError(null);
    try {
      const result = requireWorkspaceRecoveryResult(
        await getWorkspaceRecoveryAPI().deleteWorkspaceHistory(workspace.workspaceId),
      );
      if (result.result.status !== 'complete') {
        throw new Error(result.result.failures[0]?.message || t('settings.varin.recovery.storage.maintenanceFailed'));
      }
      toast.success(t('settings.varin.recovery.storage.deleteComplete'));
      await refresh();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setMaintenanceError(message);
      toast.error(message);
    } finally {
      setMaintenanceBusy(null);
    }
  }, [refresh, t]);

  const cleanup = React.useCallback(async () => {
    const cleanupWorkspaceId = workspaceId ?? storageWorkspaces.find((workspace) => workspace.storageAvailable && workspace.workspaceAvailable)?.workspaceId;
    if (!cleanupWorkspaceId) return;
    setBusy('cleanup');
    try {
      const result = requireWorkspaceRecoveryResult(
        await getWorkspaceRecoveryAPI().cleanupStorage({ workspaceId: cleanupWorkspaceId }),
      );
      if (result.result.status !== 'complete') {
        throw new Error(result.result.failures[0]?.message || t('settings.varin.recovery.storage.maintenanceFailed'));
      }
      toast.success(t(result.result.byteLengthReclaimed === 0
        ? 'settings.varin.recovery.storage.cleanupNothing'
        : 'settings.varin.recovery.storage.cleanupComplete', {
        bytes: formatWorkspaceArchiveBytes(result.result.byteLengthReclaimed),
      }));
      await refresh();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }, [refresh, storageWorkspaces, t, workspaceId]);

  const deleteHistory = React.useCallback(async () => {
    if (!workspaceId || typeof window === 'undefined') return;
    if (!window.confirm(t('settings.varin.recovery.storage.deleteConfirm'))) return;
    setBusy('delete');
    try {
      requireWorkspaceRecoveryResult(await getWorkspaceRecoveryAPI().deleteWorkspaceHistory(workspaceId));
      toast.success(t('settings.varin.recovery.storage.deleteComplete'));
      await refresh();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }, [refresh, t, workspaceId]);

  const saveRetention = React.useCallback(async () => {
    if (!workspaceId) return;
    setBusy('retention');
    try {
      const invalidRetention = t('settings.varin.recovery.retention.invalid');
      const maxByteLength = parseRetentionMiB(retention.maxByteLengthMiB, invalidRetention);
      requireWorkspaceRecoveryResult(await getWorkspaceRecoveryAPI().setRetentionPolicy({
        policy: {
          maxAgeDays: parseRetentionCount(retention.maxAgeDays, invalidRetention),
          maxByteLength,
          maxCheckpointCount: parseRetentionCount(retention.maxCheckpointCount, invalidRetention),
          maxOperationCount: parseRetentionCount(retention.maxOperationCount, invalidRetention),
        },
        workspaceId,
      }));
      toast.success(t('settings.varin.recovery.retention.saved'));
      await refresh();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }, [refresh, retention, t, workspaceId]);

  const visibleStorageWorkspaces = React.useMemo(() => storageWorkspaces.filter((workspace) => (
    workspace.checkpointCount > 0
    || (workspace.objectCount ?? 0) > 0
    || workspace.lastActivityAt !== null
    || workspace.locationSource === 'workspace'
  )), [storageWorkspaces]);
  const migratableStorageWorkspaces = React.useMemo(() => visibleStorageWorkspaces.filter((workspace) => (
    workspace.locationSource === 'global'
    && workspace.migrationRequired
    && workspace.workspaceAvailable
    && workspace.storageAvailable
  )), [visibleStorageWorkspaces]);
  const cleanableStorageWorkspaces = React.useMemo(() => visibleStorageWorkspaces.filter((workspace) => (
    workspace.storageAvailable
    && (workspace.checkpointCount > 0 || (workspace.objectCount ?? 0) > 0)
  )), [visibleStorageWorkspaces]);

  const storageManagement = status?.capabilities.storageManagement === true;
  const sharedStorage = globalStatus?.scope === 'host';
  const canCleanupShared = Boolean(workspaceId || storageWorkspaces.some((workspace) => workspace.storageAvailable && workspace.workspaceAvailable));
  const selectedLocation = status?.storage.location;
  const globalLocationChanged = globalStatus
    ? globalStatus.location.mode !== globalStorageMode
      || (globalStorageMode === 'custom' && globalStatus.location.mode === 'custom'
        && globalStatus.location.customRoot !== globalCustomRoot.trim())
    : false;
  const locationChanged = selectedLocation
    ? storageMode === 'inherit'
      ? status?.storage.locationSource !== 'global'
      : status?.storage.locationSource !== 'workspace'
        || selectedLocation.mode !== storageMode
        || (storageMode === 'custom' && selectedLocation.mode === 'custom'
          && selectedLocation.customRoot !== customRoot.trim())
    : false;
  const retentionChanged = status
    ? JSON.stringify(retention) !== JSON.stringify(retentionDraft(status.retention.policy))
    : false;

  return (
    <>
      <SettingsSection
        settingsItem="sessions.recovery"
        title={t('settings.varin.recovery.title')}
        description={t('settings.varin.recovery.description')}
      >
      <SettingsRadioGroup aria-label={t('settings.varin.recovery.preference.aria')}>
        {RECOVERY_PREFERENCES.map((option) => (
          <SettingsRadioOption
            key={option.value}
            selected={preference === option.value}
            onSelect={() => changePreference(option.value)}
            label={t(option.labelKey)}
            description={t(option.descriptionKey)}
            ariaLabel={t(option.labelKey)}
          />
        ))}
      </SettingsRadioGroup>

      <div className="space-y-4 border-t border-border/60 pt-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="typography-settings-group-title text-foreground">
              {t('settings.varin.recovery.native.title')}
            </h3>
            <p className="mt-1 typography-meta text-muted-foreground">
              {t('settings.varin.recovery.native.description')}
            </p>
          </div>
          <Button type="button" variant="ghost" size="xs" onClick={() => void refresh()} disabled={loading}>
            <Icon name="refresh" className={cn('size-3.5', loading && 'animate-spin')} />
            {t('settings.varin.recovery.actions.refresh')}
          </Button>
        </div>

        {storageManagement ? (
          <div className="space-y-3 rounded-xl border border-border/60 p-3">
            <div>
              <h4 className="typography-ui-label font-medium text-foreground">
                {t('settings.varin.recovery.storage.globalTitle')}
              </h4>
              <p className="mt-1 typography-meta text-muted-foreground">
                {t('settings.varin.recovery.storage.globalDescription')}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {STORAGE_MODES.map((option) => (
                <Button
                  key={option.mode}
                  type="button"
                  variant="chip"
                  size="sm"
                  aria-pressed={globalStorageMode === option.mode}
                  onClick={() => setGlobalStorageMode(option.mode)}
                >
                  {t(option.labelKey)}
                </Button>
              ))}
            </div>
            {globalStorageMode === 'custom' ? (
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  value={globalCustomRoot}
                  onChange={(event) => setGlobalCustomRoot(event.target.value)}
                  placeholder={t('settings.varin.recovery.storage.customPlaceholder')}
                  className="min-w-0 flex-1 font-mono typography-meta"
                />
                <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={() => void chooseStorageFolder('global')}>
                  <Icon name="folder" className="size-3.5" />
                  {t('settings.varin.recovery.storage.chooseFolder')}
                </Button>
              </div>
            ) : null}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!globalLocationChanged || busy !== null || (globalStorageMode === 'custom' && !globalCustomRoot.trim())}
              onClick={() => void saveGlobalStorage()}
            >
              {busy === 'global'
                ? t('settings.varin.recovery.storage.savingGlobal')
                : t('settings.varin.recovery.storage.saveGlobal')}
            </Button>
          </div>
        ) : null}

        {globalError ? (
          <div className="rounded-xl border border-[var(--status-error-border)] bg-[var(--status-error-background)] p-3 typography-meta text-[var(--status-error)]">
            {globalError}
          </div>
        ) : null}

        {sharedStorage && globalStatus ? (
          <div className="space-y-2 rounded-xl border border-border/60 p-3">
            <h4 className="typography-ui-label font-medium text-foreground">
              {t('settings.varin.recovery.storage.sharedTitle')}
            </h4>
            <p className="typography-meta text-muted-foreground">
              {t('settings.varin.recovery.storage.sharedSummary', {
                bytes: formatWorkspaceArchiveBytes(globalStatus.byteLength),
                count: globalStatus.objectCount,
              })}
            </p>
            <p className="typography-meta text-muted-foreground">
              {t('settings.varin.recovery.storage.sharedDescription')}
            </p>
          </div>
        ) : null}

        <div className="space-y-3 rounded-xl border border-border/60 p-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h4 className="typography-ui-label font-medium text-foreground">
                {t('settings.varin.recovery.storage.managerTitle')}
              </h4>
              <p className="mt-1 typography-meta text-muted-foreground">
                {t(storageManagement
                  ? 'settings.varin.recovery.storage.managerDescription'
                  : 'settings.varin.recovery.storage.historyDescription')}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {storageManagement ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={maintenanceBusy !== null || migratableStorageWorkspaces.length === 0}
                  onClick={() => void maintainStorageWorkspaces('migrate', migratableStorageWorkspaces)}
                >
                  {t('settings.varin.recovery.storage.migrateAll')}
                </Button>
              ) : null}
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy !== null || maintenanceBusy !== null || (sharedStorage ? !canCleanupShared : cleanableStorageWorkspaces.length === 0)}
                onClick={() => void (sharedStorage ? cleanup() : maintainStorageWorkspaces('cleanup', cleanableStorageWorkspaces))}
              >
                {t(sharedStorage ? 'settings.varin.recovery.storage.cleanupShared' : 'settings.varin.recovery.storage.cleanupAll')}
              </Button>
            </div>
          </div>

          {visibleStorageWorkspaces.length === 0 ? (
            <p className="rounded-lg bg-muted/20 px-3 py-2 typography-meta text-muted-foreground">
              {t('settings.varin.recovery.storage.managerEmpty')}
            </p>
          ) : (
            <div className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/60">
              {visibleStorageWorkspaces.map((workspace) => {
                const rowBusy = maintenanceBusy?.endsWith(workspace.workspaceId) === true;
                return (
                  <div key={workspace.workspaceId} className="space-y-2 p-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate font-mono typography-meta text-foreground" title={workspace.canonicalRoot}>
                          {workspace.canonicalRoot}
                        </p>
                        <p className="mt-1 typography-micro text-muted-foreground">
                          {workspace.lastActivityAt
                            ? t('settings.varin.recovery.storage.lastActivity', {
                              time: new Date(workspace.lastActivityAt).toLocaleString(),
                            })
                            : t('settings.varin.recovery.storage.neverUsed')}
                          {' · '}
                          {t('settings.varin.recovery.storage.checkpointCount', { count: workspace.checkpointCount })}
                          {workspace.byteLength === undefined ? null : (
                            <> · {formatWorkspaceArchiveBytes(workspace.byteLength)}</>
                          )}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {workspace.locationSource === 'workspace' ? (
                          <span className="rounded-full bg-muted px-2 py-0.5 typography-micro text-muted-foreground">
                            {t('settings.varin.recovery.storage.projectOverride')}
                          </span>
                        ) : null}
                        {workspace.migrationRequired ? (
                          <span className="rounded-full bg-[var(--status-warning-background)] px-2 py-0.5 typography-micro text-[var(--status-warning)]">
                            {t('settings.varin.recovery.storage.migrationPending')}
                          </span>
                        ) : null}
                        {!workspace.workspaceAvailable ? (
                          <span className="rounded-full bg-[var(--status-error-background)] px-2 py-0.5 typography-micro text-[var(--status-error)]">
                            {t('settings.varin.recovery.storage.workspaceOffline')}
                          </span>
                        ) : null}
                        {!workspace.storageAvailable ? (
                          <span className="rounded-full bg-[var(--status-error-background)] px-2 py-0.5 typography-micro text-[var(--status-error)]">
                            {t('settings.varin.recovery.storage.storageUnavailable')}
                          </span>
                        ) : null}
                      </div>
                    </div>
                    {storageManagement ? <div className="flex flex-wrap gap-2">
                      {storageManagement && workspace.locationSource === 'global' && workspace.migrationRequired ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          disabled={maintenanceBusy !== null
                            || !workspace.workspaceAvailable
                            || !workspace.storageAvailable}
                          onClick={() => void maintainStorageWorkspaces('migrate', [workspace])}
                        >
                          {t('settings.varin.recovery.storage.migrateOne')}
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        disabled={maintenanceBusy !== null
                          || !workspace.storageAvailable
                          || (workspace.checkpointCount === 0 && (workspace.objectCount ?? 0) === 0)}
                        onClick={() => void maintainStorageWorkspaces('cleanup', [workspace])}
                      >
                        {t('settings.varin.recovery.storage.cleanupOne')}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        disabled={maintenanceBusy !== null
                          || !workspace.storageAvailable
                          || (workspace.checkpointCount === 0 && (workspace.objectCount ?? 0) === 0)}
                        className="text-[var(--status-error)] hover:text-[var(--status-error)]"
                        onClick={() => void deleteStoredWorkspaceHistory(workspace)}
                      >
                        {rowBusy
                          ? t('settings.varin.recovery.storage.working')
                          : t('settings.varin.recovery.storage.deleteStored')}
                      </Button>
                    </div> : null}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {maintenanceError ? (
          <div className="rounded-xl border border-[var(--status-error-border)] bg-[var(--status-error-background)] p-3 typography-meta text-[var(--status-error)]">
            {maintenanceError}
          </div>
        ) : null}

        {!workspaceId ? (
          <div className="rounded-xl border border-border/60 bg-muted/20 p-3 typography-meta text-muted-foreground">
            {t('settings.varin.recovery.native.openWorkspace')}
          </div>
        ) : null}

        {status?.capabilities.retention ? (
          <div className="rounded-xl border border-border/60 p-3">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <span className="typography-ui-label font-medium text-foreground">varin.builtin.recovery</span>
              <span className={cn('typography-micro', statusTone(status.storage.state))}>
                {status.storage.state}
              </span>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div>
                <p className="typography-micro text-muted-foreground">{t('settings.varin.recovery.storage.checkpoints')}</p>
                <p className="mt-1 typography-ui-label tabular-nums">{status.storage.checkpointCount}</p>
              </div>
              <div>
                <p className="typography-micro text-muted-foreground">{t('settings.varin.recovery.storage.readyCheckpoints')}</p>
                <p className="mt-1 typography-ui-label tabular-nums">{status.storage.readyCheckpointCount}</p>
              </div>
              <div>
                <p className="typography-micro text-muted-foreground">{t('settings.varin.recovery.storage.objects')}</p>
                <p className="mt-1 typography-ui-label tabular-nums">{status.storage.objectCount}</p>
              </div>
              <div>
                <p className="typography-micro text-muted-foreground">{t('settings.varin.recovery.storage.size')}</p>
                <p className="mt-1 typography-ui-label tabular-nums">
                  {formatWorkspaceArchiveBytes(status.storage.byteLength)}
                </p>
              </div>
            </div>
          </div>
        ) : null}

        {status ? (
          <div className="space-y-3 rounded-xl border border-border/60 p-3">
            <div>
              <h4 className="typography-ui-label font-medium text-foreground">
                {t('settings.varin.recovery.retention.title')}
              </h4>
              <p className="mt-1 typography-meta text-muted-foreground">
                {t('settings.varin.recovery.retention.description')}
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1 typography-meta text-muted-foreground">
                <span>{t('settings.varin.recovery.retention.maxCheckpoints')}</span>
                <Input
                  type="number"
                  min={0}
                  step={1}
                  value={retention.maxCheckpointCount}
                  placeholder={t('settings.varin.recovery.retention.unlimited')}
                  onChange={(event) => setRetention((current) => ({ ...current, maxCheckpointCount: event.target.value }))}
                />
              </label>
              <label className="space-y-1 typography-meta text-muted-foreground">
                <span>{t('settings.varin.recovery.retention.maxOperations')}</span>
                <Input
                  type="number"
                  min={0}
                  step={1}
                  value={retention.maxOperationCount}
                  placeholder={t('settings.varin.recovery.retention.unlimited')}
                  onChange={(event) => setRetention((current) => ({ ...current, maxOperationCount: event.target.value }))}
                />
              </label>
              <label className="space-y-1 typography-meta text-muted-foreground">
                <span>{t('settings.varin.recovery.retention.maxAgeDays')}</span>
                <Input
                  type="number"
                  min={0}
                  step={1}
                  value={retention.maxAgeDays}
                  placeholder={t('settings.varin.recovery.retention.unlimited')}
                  onChange={(event) => setRetention((current) => ({ ...current, maxAgeDays: event.target.value }))}
                />
              </label>
              <label className="space-y-1 typography-meta text-muted-foreground">
                <span>{t('settings.varin.recovery.retention.maxMiB')}</span>
                <Input
                  type="number"
                  min={0}
                  step="any"
                  value={retention.maxByteLengthMiB}
                  placeholder={t('settings.varin.recovery.retention.unlimited')}
                  onChange={(event) => setRetention((current) => ({ ...current, maxByteLengthMiB: event.target.value }))}
                />
              </label>
            </div>
            <p className="typography-micro text-muted-foreground">
              {t('settings.varin.recovery.retention.summary', {
                eligible: status.retention.eligibleCheckpointCount,
                protected: status.retention.protectedCheckpointCount + status.retention.protectedOperationCount,
              })}
            </p>
            {status.retention.oldestProtectedOperationAt ? (
              <p className="typography-micro text-[var(--status-warning)]">
                {t('settings.varin.recovery.retention.protectedSince', {
                  time: new Date(status.retention.oldestProtectedOperationAt).toLocaleString(),
                })}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!retentionChanged || busy !== null}
                onClick={() => void saveRetention()}
              >
                {busy === 'retention'
                  ? t('settings.varin.recovery.retention.saving')
                  : t('settings.varin.recovery.retention.save')}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy !== null}
                onClick={() => setRetention(retentionDraft())}
              >
                {t('settings.varin.recovery.retention.clearLimits')}
              </Button>
            </div>
          </div>
        ) : null}

        {status && storageManagement ? (
          <div className="space-y-3 rounded-xl border border-border/60 p-3">
            <div>
              <h4 className="typography-ui-label font-medium text-foreground">
                {t('settings.varin.recovery.storage.projectTitle')}
              </h4>
              <p className="mt-1 typography-meta text-muted-foreground">
                {t('settings.varin.recovery.storage.projectDescription')}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="chip"
                size="sm"
                aria-pressed={storageMode === 'inherit'}
                onClick={() => setStorageMode('inherit')}
              >
                {t('settings.varin.recovery.storage.inheritGlobal')}
              </Button>
              {STORAGE_MODES.map((option) => (
                <Button
                  key={option.mode}
                  type="button"
                  variant="chip"
                  size="sm"
                  aria-pressed={storageMode === option.mode}
                  onClick={() => setStorageMode(option.mode)}
                >
                  {t(option.labelKey)}
                </Button>
              ))}
            </div>
            {storageMode === 'custom' ? (
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  value={customRoot}
                  onChange={(event) => setCustomRoot(event.target.value)}
                  placeholder={t('settings.varin.recovery.storage.customPlaceholder')}
                  className="min-w-0 flex-1 font-mono typography-meta"
                />
                <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={() => void chooseStorageFolder('workspace')}>
                  <Icon name="folder" className="size-3.5" />
                  {t('settings.varin.recovery.storage.chooseFolder')}
                </Button>
              </div>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!locationChanged || busy !== null || (storageMode === 'custom' && !customRoot.trim())}
                onClick={() => void moveStorage()}
              >
                {busy === 'move'
                  ? t('settings.varin.recovery.storage.moving')
                  : t('settings.varin.recovery.storage.move')}
              </Button>
              <Button type="button" variant="outline" size="sm" disabled={busy !== null} onClick={() => void cleanup()}>
                {t('settings.varin.recovery.storage.cleanup')}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy !== null || status.storage.checkpointCount === 0}
                className="text-[var(--status-error)] hover:text-[var(--status-error)]"
                onClick={() => void deleteHistory()}
              >
                {t('settings.varin.recovery.storage.delete')}
              </Button>
            </div>
          </div>
        ) : null}

        {error ? (
          <div className="rounded-xl border border-[var(--status-error-border)] bg-[var(--status-error-background)] p-3 typography-meta text-[var(--status-error)]">
            {error}
          </div>
        ) : null}
      </div>
      </SettingsSection>
      <DirectoryExplorerDialog
        open={pickerTarget !== null}
        onOpenChange={(open) => { if (!open) setPickerTarget(null); }}
        mode="select-directory"
        initialPath={pickerTarget === 'global' ? globalCustomRoot : customRoot}
        title={t('settings.varin.recovery.storage.folderPickerTitle')}
        description={t('settings.varin.recovery.storage.folderPickerDescription')}
        confirmLabel={t('settings.varin.recovery.storage.chooseFolder')}
        onSelectDirectory={(selected) => {
          if (pickerTarget === 'global') setGlobalCustomRoot(selected);
          else if (pickerTarget === 'workspace') setCustomRoot(selected);
        }}
      />
    </>
  );
};
