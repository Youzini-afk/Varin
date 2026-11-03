import { getVarinExtensionCatalogState } from '@/lib/extensions/catalog-store';
import { captureExtensionCodeReview, profileShellCodeToEnable } from '@/lib/extensions/code-trust';
import { selectActiveWorkbenchProfile } from '@/lib/extensions/workbench-shell-transition';
import { varinSurfaceRuntime } from '@/lib/extensions/surface-runtime';

import React from 'react';
import type { VarinExtensionPublicPackageSource } from '@varin/extension-contract';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useI18n } from '@/lib/i18n';

interface CodeTrustRequest {
  artifacts: readonly { extensionId?: string; version?: string; integrity?: string; source: VarinExtensionPublicPackageSource }[];
  restart?: boolean;
}

/** The pending request captures what is shown; a later catalog render cannot replace it. */
export const useExtensionCodeTrust = () => {
  const { t } = useI18n();
  const [request, setRequest] = React.useState<CodeTrustRequest | null>(null);
  const pending = React.useRef<((accepted: boolean) => void) | null>(null);
  const settle = React.useCallback((accepted: boolean) => {
    const resolve = pending.current; pending.current = null; setRequest(null); resolve?.(accepted);
  }, []);
  React.useEffect(() => () => { pending.current?.(false); pending.current = null; }, []);
  const confirm = React.useCallback((next: CodeTrustRequest): Promise<boolean> => {
    pending.current?.(false);
    return new Promise(resolve => { pending.current = resolve; setRequest(next); });
  }, []);
  return { confirm, dialog: (
    <Dialog open={request !== null} onOpenChange={open => { if (!open) settle(false); }}>
      <DialogContent className="max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('settings.varin.extensions.codeTrust.title')}</DialogTitle>
          <DialogDescription>{t('settings.varin.extensions.codeTrust.description')}</DialogDescription>
        </DialogHeader>
        <p className="typography-meta">{t('settings.varin.extensions.codeTrust.capabilities')}</p>
        {request?.artifacts.map((artifact, index) => <div key={index} className="space-y-1 break-all rounded-md bg-interactive-hover p-3 typography-micro">
          {artifact.extensionId ? <div>{artifact.extensionId}{artifact.version ? ` · v${artifact.version}` : ''}</div> : null}
          <div>{artifact.source.kind} · {artifact.source.display}</div>
          {artifact.version ? <div>{t('settings.varin.extensions.inspector.integrity')}: {artifact.integrity ?? t('settings.varin.extensions.codeTrust.noIntegrity')}</div> : null}
        </div>)}
        {request?.restart ? <p className="typography-meta">{t('settings.varin.extensions.restart.confirmDescription')}</p> : null}
        <DialogFooter>
          <Button variant="ghost" onClick={() => settle(false)}>{t('settings.common.actions.cancel')}</Button>
          <Button onClick={() => settle(true)}>{t(request?.restart ? 'settings.varin.extensions.codeTrust.restart' : 'settings.varin.extensions.codeTrust.confirm')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ) };
};

/** Shared by profile controls; ordinary navigation never silently approves a disabled external Shell. */
export const useCodeTrustedProfileSelection = () => {
  const trust = useExtensionCodeTrust();
  const selectProfile = async (profileId: string, workspaceId?: string): Promise<void> => {
    const snapshot = getVarinExtensionCatalogState().snapshot;
    if (!snapshot) throw new Error('Varin extension catalog is unavailable');
    const entries = profileShellCodeToEnable(snapshot, profileId, varinSurfaceRuntime.surface, workspaceId);
    const codeReview = entries.length ? captureExtensionCodeReview(snapshot, entries) : undefined;
    if (codeReview && !await trust.confirm({ artifacts: codeReview.artifacts })) return;
    await selectActiveWorkbenchProfile(profileId, workspaceId, { enableShell: true, ...(codeReview ? { codeReview } : {}) });
  };
  return { selectProfile, dialog: trust.dialog };
};
