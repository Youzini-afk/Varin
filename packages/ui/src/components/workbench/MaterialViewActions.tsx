import React from 'react';
import { VARIN_WORKBENCH_IDE_PROFILE_ID } from '@varin/extension-contract';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { useVarinExtensionCatalog } from '@/lib/extensions/catalog-store';
import { continueBrowserInIde, continueMaterialInIde, returnMaterialToConversation } from '@/lib/agent-editor/material-navigation';
import { useWorkbenchProfileId } from '@/lib/workbench/profile-context';
import type { EditorTab } from '@/lib/workbench/editors/types';
import { varinSurfaceRuntime } from '@/lib/extensions/surface-runtime';

export function MaterialViewActions({ workspaceId, workspaceRoot, tab }: {
  workspaceId: string; workspaceRoot: string; tab: EditorTab;
}) {
  const { t } = useI18n();
  const profileId = useWorkbenchProfileId();
  const catalog = useVarinExtensionCatalog();
  const [pending, setPending] = React.useState(false);
  const ide = profileId === VARIN_WORKBENCH_IDE_PROFILE_ID;
  if (varinSurfaceRuntime.surface === 'mobile' || !catalog.snapshot?.workbench?.authoritative
    || !catalog.snapshot.workbench.document.profiles.some(profile => profile.id === VARIN_WORKBENCH_IDE_PROFILE_ID)) return null;
  const label = t(ide ? 'workbench.material.returnToChat' : 'workbench.material.continueInIde');
  return <button type="button" disabled={pending} title={label} aria-label={label}
    className="workbench-icon-button flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-interactive-hover hover:text-foreground disabled:opacity-40"
    onClick={() => {
      setPending(true);
      void (ide ? returnMaterialToConversation(workspaceId, workspaceRoot, tab.viewId)
        : continueMaterialInIde({ workspaceId, viewId: tab.viewId, fromProfileId: profileId }))
        .catch(error => toast.error(error instanceof Error ? error.message : String(error)))
        .finally(() => setPending(false));
    }}>
    <Icon name={pending ? 'loader-4' : ide ? 'chat-1' : 'code-box'} className={`size-3.5${pending ? ' animate-spin' : ''}`} />
  </button>;
}

export function BrowserMaterialAction({ workspaceRoot, tabId, url }: { workspaceRoot: string; tabId: string; url: string }) {
  const { t } = useI18n();
  const fromProfileId = useWorkbenchProfileId();
  const catalog = useVarinExtensionCatalog();
  const [pending, setPending] = React.useState(false);
  if (varinSurfaceRuntime.surface === 'mobile' || !url || !catalog.snapshot?.workbench?.authoritative
    || !catalog.snapshot.workbench.document.profiles.some(profile => profile.id === VARIN_WORKBENCH_IDE_PROFILE_ID)) return null;
  return <button type="button" disabled={pending} title={t('workbench.material.continueInIde')} aria-label={t('workbench.material.continueInIde')}
    className="workbench-icon-button flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-interactive-hover hover:text-foreground disabled:opacity-40"
    onClick={() => {
      setPending(true);
      void continueBrowserInIde({ workspaceRoot, tabId, url, fromProfileId })
        .catch(error => toast.error(error instanceof Error ? error.message : String(error)))
        .finally(() => setPending(false));
    }}><Icon name={pending ? 'loader-4' : 'code-box'} className={`size-3.5${pending ? ' animate-spin' : ''}`} /></button>;
}
