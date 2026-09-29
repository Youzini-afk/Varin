import React from 'react';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { useI18n } from '@/lib/i18n';
import {
  listVirtualMachines,
  listVmProviderConfigs,
  saveVmProviderConfigs,
  createVirtualMachine,
  runVmAction,
  deleteVirtualMachine,
} from '@/lib/computers';
import type { ComputerVmDescriptor, ComputerVmProviderConfig } from '@varin/protocol';

/**
 * BC7 virtual machines: provider configuration (libvirt connection URIs),
 * the VM inventory with live domain state, and lifecycle actions. Provider
 * reachability and domain state come from the Host — nothing here simulates
 * a hypervisor.
 */
export function ComputerVmSection({ onCatalogChanged }: { onCatalogChanged?: () => Promise<void> }) {
  const { t } = useI18n();
  const [providers, setProviders] = React.useState<ComputerVmProviderConfig[] | null>(null);
  const [vms, setVms] = React.useState<ComputerVmDescriptor[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);

  // Provider draft form
  const [providerId, setProviderId] = React.useState('');
  const [providerUri, setProviderUri] = React.useState('qemu:///system');
  // Create form
  const [vmProviderId, setVmProviderId] = React.useState('');
  const [vmName, setVmName] = React.useState('');
  const [vmMemory, setVmMemory] = React.useState('4096');
  const [vmCpus, setVmCpus] = React.useState('4');
  const [vmDisk, setVmDisk] = React.useState('40');
  const [vmBaseImage, setVmBaseImage] = React.useState('');
  const [vmManaged, setVmManaged] = React.useState(true);
  const [deleteDisks, setDeleteDisks] = React.useState(false);
  const readyGuests = React.useRef<string | null>(null);

  const refresh = React.useCallback(async () => {
    try {
      const [providerList, vmList] = await Promise.all([listVmProviderConfigs(), listVirtualMachines()]);
      setProviders(providerList);
      setVms(vmList);
      setVmProviderId((current) => current || providerList[0]?.id || '');
      const ready = vmList.filter((vm) => vm.binding.guest?.state === 'ready').map((vm) => vm.machineId).sort().join(',');
      if (readyGuests.current !== ready) {
        readyGuests.current = ready;
        void onCatalogChanged?.();
      }
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [onCatalogChanged]);

  React.useEffect(() => { void refresh(); }, [refresh]);
  React.useEffect(() => {
    if (!vms?.some((vm) => vm.binding.guest && (vm.binding.guest.state === 'preparing' || vm.binding.guest.state === 'failed'))) return;
    const timer = setInterval(() => { void refresh(); }, 10_000);
    return () => clearInterval(timer);
  }, [vms, refresh]);

  const addProvider = async () => {
    const id = providerId.trim();
    const uri = providerUri.trim();
    if (!id || !uri || providers === null) return;
    if (providers.some((p) => p.id === id)) {
      setError(t('settings.computers.vm.provider.duplicate'));
      return;
    }
    setBusy('provider');
    try {
      await saveVmProviderConfigs([...providers, { id, uri, kind: 'libvirt' }]);
      setProviderId('');
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const removeProvider = async (id: string) => {
    if (providers === null) return;
    setBusy(`provider:${id}`);
    try {
      await saveVmProviderConfigs(providers.filter((p) => p.id !== id));
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const createVm = async () => {
    if (!vmProviderId || !vmName.trim()) return;
    setBusy('create');
    try {
      await createVirtualMachine({
        providerId: vmProviderId,
        name: vmName.trim(),
        memoryMiB: Number(vmMemory) || 4096,
        vcpus: Number(vmCpus) || 4,
        diskGiB: Number(vmDisk) || 40,
        managed: vmManaged,
        ...(!vmManaged && vmBaseImage.trim() ? { baseImage: vmBaseImage.trim() } : {}),
      });
      setVmName('');
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const vmAction = async (machineId: string, action: 'start' | 'shutdown' | 'reboot' | 'upgrade') => {
    setBusy(`${action}:${machineId}`);
    try {
      await runVmAction(machineId, action);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const removeVm = async (machineId: string) => {
    setBusy(`delete:${machineId}`);
    try {
      await deleteVirtualMachine(machineId, deleteDisks);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const vmStateLabel = (vm: ComputerVmDescriptor): string => {
    switch (vm.state) {
      case 'running': return t('settings.computers.vm.state.running');
      case 'paused': return t('settings.computers.vm.state.paused');
      case 'shutoff': return t('settings.computers.vm.state.shutoff');
      case 'crashed': return t('settings.computers.vm.state.crashed');
      default: return t('settings.computers.vm.state.unknown');
    }
  };

  const guestStateLabel = (state: NonNullable<ComputerVmDescriptor['binding']['guest']>['state']): string => {
    switch (state) {
      case 'preparing': return t('settings.computers.setup.preparing');
      case 'ready': return t('settings.computers.status.available');
      case 'failed': return t('settings.computers.status.unavailable');
      case 'stopped': return t('settings.computers.status.stopped');
    }
  };

  return <>
    {error ? <div role="alert" className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
      <p className="typography-meta text-destructive">{error}</p>
    </div> : null}

    <SettingsSection title={t('settings.computers.vm.section.providers')} contentClassName="space-y-3">
      {providers?.length ? providers.map((provider) => (
        <div key={provider.id} className="flex items-center justify-between gap-3 rounded-lg border border-border/60 p-3">
          <div className="min-w-0">
            <p className="typography-ui-label text-foreground truncate">{provider.label ?? provider.id}</p>
            <p className="typography-meta text-muted-foreground truncate">{provider.kind} · {provider.uri}</p>
          </div>
          <Button variant="outline" size="sm" disabled={busy === `provider:${provider.id}`}
            onClick={() => { void removeProvider(provider.id); }}>
            {t('settings.computers.vm.provider.remove')}
          </Button>
        </div>
      )) : <p className="typography-meta text-muted-foreground">{t('settings.computers.vm.provider.empty')}</p>}
      <div className="flex items-end gap-2">
        <Input value={providerId} onChange={(event) => setProviderId(event.target.value)}
          placeholder={t('settings.computers.vm.provider.idPlaceholder')} className="w-40" />
        <Input value={providerUri} onChange={(event) => setProviderUri(event.target.value)}
          placeholder="qemu:///system" className="flex-1" />
        <Button variant="outline" size="sm" disabled={busy === 'provider' || !providerId.trim() || !providerUri.trim()}
          onClick={() => { void addProvider(); }}>
          {t('settings.computers.vm.provider.add')}
        </Button>
      </div>
    </SettingsSection>

    <SettingsSection title={t('settings.computers.vm.section.vms')} contentClassName="space-y-4">
      {providers && providers.length > 0 ? (
        <div className="rounded-lg border border-border/60 p-4 space-y-3">
          <p className="typography-ui-label text-foreground">{t('settings.computers.vm.create.title')}</p>
          <div className="grid grid-cols-2 gap-2">
            <Select value={vmProviderId} onValueChange={setVmProviderId}>
              <SelectTrigger size="settings" aria-label={t('settings.computers.vm.create.provider')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {providers.map((provider) => (
                  <SelectItem key={provider.id} value={provider.id}>{provider.label ?? provider.id}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input value={vmName} onChange={(event) => setVmName(event.target.value)}
              placeholder={t('settings.computers.vm.create.namePlaceholder')} />
            <Input value={vmMemory} onChange={(event) => setVmMemory(event.target.value)}
              placeholder={t('settings.computers.vm.create.memory')} inputMode="numeric" />
            <Input value={vmCpus} onChange={(event) => setVmCpus(event.target.value)}
              placeholder={t('settings.computers.vm.create.vcpus')} inputMode="numeric" />
            <Input value={vmDisk} onChange={(event) => setVmDisk(event.target.value)}
              placeholder={t('settings.computers.vm.create.disk')} inputMode="numeric" />
            {!vmManaged ? <Input value={vmBaseImage} onChange={(event) => setVmBaseImage(event.target.value)}
              placeholder={t('settings.computers.vm.create.baseImage')} /> : null}
          </div>
          <label className="flex items-center gap-2 typography-meta text-muted-foreground">
            <Checkbox checked={vmManaged} onChange={setVmManaged} ariaLabel={t('settings.computers.vm.create.managed')} />
            {t('settings.computers.vm.create.managed')}
          </label>
          <Button variant="outline" size="sm" disabled={busy === 'create' || !vmName.trim() || !vmProviderId}
            onClick={() => { void createVm(); }}>
            {busy === 'create' ? t('settings.computers.vm.create.creating') : t('settings.computers.vm.create.submit')}
          </Button>
        </div>
      ) : null}

      {vms === null ? <p role="status" className="typography-meta text-muted-foreground">{t('common.loading')}</p>
        : vms.length === 0 ? <p className="typography-meta text-muted-foreground">{t('settings.computers.vm.empty')}</p>
        : vms.map((vm) => (
          <div key={vm.machineId} className="rounded-lg border border-border/60 p-4 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="typography-ui-label text-foreground truncate">{vm.name}</p>
                <p className="typography-meta text-muted-foreground truncate">
                  {vm.binding.uri} · {vm.binding.domainUuid || t('settings.computers.vm.noDomain')}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className={`typography-meta ${vm.state === 'running' ? 'text-foreground' : 'text-muted-foreground'}`}>
                  {vmStateLabel(vm)}
                </span>
                <Button variant="outline" size="sm" disabled={busy !== null || vm.state === 'running' || !vm.binding.domainUuid}
                  onClick={() => { void vmAction(vm.machineId, 'start'); }}>
                  {t('settings.computers.vm.action.start')}
                </Button>
                <Button variant="outline" size="sm" disabled={busy !== null || vm.state !== 'running' || !vm.binding.domainUuid}
                  onClick={() => { void vmAction(vm.machineId, 'shutdown'); }}>
                  {t('settings.computers.vm.action.shutdown')}
                </Button>
                <Button variant="outline" size="sm" disabled={busy !== null || vm.state !== 'running' || !vm.binding.domainUuid}
                  onClick={() => { void vmAction(vm.machineId, 'reboot'); }}>
                  {t('settings.computers.vm.action.reboot')}
                </Button>
                {vm.binding.guest ? <Button variant="outline" size="sm" disabled={busy !== null || vm.state !== 'shutoff'}
                  onClick={() => { void vmAction(vm.machineId, 'upgrade'); }}>
                  {t('settings.computers.vm.action.upgrade')}
                </Button> : null}
                <Button variant="outline" size="sm" disabled={busy !== null}
                  onClick={() => { void removeVm(vm.machineId); }}>
                  {t('settings.computers.vm.action.delete')}
                </Button>
              </div>
            </div>
            {vm.statusDetail ? <p className="typography-meta text-muted-foreground">{vm.statusDetail}</p> : null}
            {vm.binding.guest ? <p className="typography-meta text-muted-foreground">
              {t('settings.computers.vm.create.managed')}: {guestStateLabel(vm.binding.guest.state)}
              {vm.binding.guest.detail ? ` · ${vm.binding.guest.detail}` : ''}
            </p> : null}
            <label className="flex items-center gap-2 typography-meta text-muted-foreground">
              <Checkbox checked={deleteDisks} onChange={setDeleteDisks} ariaLabel={t('settings.computers.vm.deleteDisks')} />
              {t('settings.computers.vm.deleteDisks')}
            </label>
          </div>
        ))}
    </SettingsSection>
  </>;
}
