import React from 'react';
import { FRONTEND_RECOVERED_DRAFTS_KEY, FRONTEND_MIGRATION_MARKER_KEY, NATIVE_MIGRATION_RECOVERY_KEY, type FrontendRecoveredDraft } from '@varin/application-client/desktop';
import { requestSettingsNavigation } from '@/lib/settings/drafts';
import { invokeDesktop } from '@/lib/desktop';
import { getDesktopRuntime } from '@/lib/desktopRuntime';
import { useThreadStore, selectedComposerKey } from '@/stores/useThreadStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useUIStore } from '@/stores/useUIStore';
import { useThreadDraftStore } from '@/stores/useThreadDraftStore';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { useI18n } from '@/lib/i18n';
function recovered(): FrontendRecoveredDraft[] {
  if (getDesktopRuntime()?.runtime !== 'tauri')
    return [];
  try {
    const value = JSON.parse(localStorage.getItem(FRONTEND_RECOVERED_DRAFTS_KEY) || 'null');
    return value?.schema === 1 && Array.isArray(value.drafts) ? value.drafts.filter((d: FrontendRecoveredDraft) => typeof d?.target === 'string' && typeof d.message?.content === 'string') : [];
  }
  catch {
    return [];
  }
}
interface NativeRecovery { credentialSlotsPending: string[]; browserSites: string[]; browserRecoveryAcknowledged?: boolean;browserSourceUnavailable:boolean;companionFailures:Array<{id:string;reason:string}> }
function nativeRecovery(): NativeRecovery | null {
  if (getDesktopRuntime()?.runtime !== 'tauri') return null;
  try {
    const value=JSON.parse(localStorage.getItem(NATIVE_MIGRATION_RECOVERY_KEY)||'null');
    if(value?.schema!==1||!Array.isArray(value.credentialSlotsPending)||!Array.isArray(value.browserSites))return null;
    return {browserSourceUnavailable:value.browserSourceUnavailable===true,companionFailures:Array.isArray(value.companionFailures)?value.companionFailures.filter((item:{id?:unknown;reason?:unknown})=>typeof item?.id==='string'&&typeof item.reason==='string'):[],credentialSlotsPending:value.credentialSlotsPending.filter((slot:unknown)=>typeof slot==='string'),browserSites:value.browserSites.filter((site:unknown)=>{try{return typeof site==='string'&&new URL(site).origin===site&&/^https?:/.test(site);}catch{return false;}}),browserRecoveryAcknowledged:value.browserRecoveryAcknowledged===true};
  }catch{return null;}
}
/** Recovered queued inputs are inspectable drafts. They never enter an executor
 * queue; inserting text is an explicit user action and does not send it. */
export function DesktopMigrationRecovery() {
  const { t } = useI18n();
  const [drafts, setDrafts] = React.useState(recovered), [open, setOpen] = React.useState(false), [error, setError] = React.useState('');
  const [native,setNative]=React.useState(nativeRecovery);
  const directory=useDirectoryStore(state=>state.currentDirectory);
  const [credentials, setCredentials] = React.useState(() => {
    if (getDesktopRuntime()?.runtime !== 'tauri')
      return false; try {
        const migrated=nativeRecovery();if(migrated)return migrated.credentialSlotsPending.length>0;
        return !!JSON.parse(localStorage.getItem(FRONTEND_MIGRATION_MARKER_KEY) || 'null')?.credentialSlots?.length;
      }
    catch {
      return false;
    }
  });
  const composerKey = useThreadStore(selectedComposerKey);
  const dismiss = (index: number) => {
    const next = drafts.filter((_, i) => i !== index); try {
      localStorage.setItem(FRONTEND_RECOVERED_DRAFTS_KEY, JSON.stringify({ schema: 1, drafts: next }));
      setDrafts(next);
    }
      catch {
        setError(t('desktopMigration.saveFailed'));
      }
  };
  const insert = (draft: FrontendRecoveredDraft) => {
    if (!composerKey)
      return; useThreadDraftStore.getState().patch(composerKey, current => ({ text: [current.text.trimEnd(), String(draft.message.content)].filter(Boolean).join('\n\n') })); setOpen(false);
  };
  const browserRecovery=!!native&&!native.browserRecoveryAcknowledged;
  const dismissBrowser=()=>{try{const current=JSON.parse(localStorage.getItem(NATIVE_MIGRATION_RECOVERY_KEY)||'null');localStorage.setItem(NATIVE_MIGRATION_RECOVERY_KEY,JSON.stringify({...current,browserRecoveryAcknowledged:true}));setNative(previous=>previous?{...previous,browserRecoveryAcknowledged:true}:null);}catch{setError(t('desktopMigration.saveFailed'));}};
  const openSettings=(slug:string)=>requestSettingsNavigation(()=>{useUIStore.getState().setSettingsPage(slug);useUIStore.getState().setSettingsDialogOpen(true);setOpen(false);});
  const retryPack=(id:string)=>{void invokeDesktop('desktop_companion_library',{action:'download',id}).then(()=>openSettings('companion')).catch(()=>setError(t('desktopMigration.packRetryFailed')));};
  const packReasons:Record<string,string>={'source-validation':t('desktopMigration.packInvalid'),'asset-integrity':t('desktopMigration.packIntegrity'),'destination-conflict':t('desktopMigration.packConflict'),'publication-unavailable':t('desktopMigration.packPublication'),'source-cache-unavailable':t('desktopMigration.packUnavailable')};
  if (!drafts.length && !credentials && !browserRecovery && !native?.companionFailures.length)
    return null;
  return <>
    <Button className="fixed bottom-3 left-3 z-50 shadow-md" variant="outline" onClick={() => setOpen(true)}>{t('desktopMigration.review')}</Button>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>{t('desktopMigration.title')}</DialogTitle><DialogDescription>{t('desktopMigration.description')}</DialogDescription></DialogHeader>
      {credentials && <section className="rounded-md border border-border p-3 text-sm"><p>{t('desktopMigration.credentials')}</p><Button variant="outline" onClick={()=>openSettings('voice')}>{t('desktopMigration.openVoice')}</Button><Button variant="ghost" onClick={() => setCredentials(false)}>{t('desktopMigration.closeNotice')}</Button></section>}
      {browserRecovery&&<section className="space-y-2 rounded-md border border-border p-3 text-sm">
        <p>{t(native?.browserSourceUnavailable?'desktopMigration.browserUnavailable':'desktopMigration.browserStorage')}</p>
        <p className="text-muted-foreground">{t('desktopMigration.browserInventory')}</p>
        {native?.browserSites.map(site=><Button className="mr-2" key={site} variant="outline" disabled={!directory} onClick={()=>{useUIStore.getState().openContextBrowser(directory,site);setOpen(false);}}>{t('desktopMigration.openSite')}: {site}</Button>)}
        <Button variant="ghost" onClick={dismissBrowser}>{t('desktopMigration.closeNotice')}</Button>
      </section>}
      {!!native?.companionFailures.length&&<section className="space-y-2 rounded-md border border-border p-3 text-sm">
        <p>{t('desktopMigration.packs')}</p>
        {native.companionFailures.map(pack=><div key={pack.id} className="space-y-1"><p>{pack.id}: {packReasons[pack.reason]??t('desktopMigration.packUnavailable')}</p><Button variant="outline" onClick={()=>retryPack(pack.id)}>{t('desktopMigration.retryPack')}: {pack.id}</Button></div>)}
        <Button variant="outline" onClick={()=>openSettings('companion')}>{t('desktopMigration.openCompanions')}</Button>
      </section>}
      {drafts.map((draft, index) => <section className="space-y-2 rounded-md border border-border p-3" key={`${draft.target}:${index}`}>
        <p className="break-all text-xs text-muted-foreground">{draft.target}</p><textarea className="min-h-32 w-full rounded-md border border-border bg-background p-2 text-sm" readOnly aria-label={t('desktopMigration.draft')} value={String(draft.message.content)} />
        <details className="text-xs"><summary>{t('desktopMigration.metadata')}</summary><pre className="overflow-auto whitespace-pre-wrap">{JSON.stringify({ ...draft.message, content: undefined }, null, 2)}</pre></details>
        <p className="text-xs text-muted-foreground">{t('desktopMigration.attachments')}</p>
        <div className="flex flex-wrap gap-2"><Button disabled={!composerKey} onClick={() => insert(draft)}>{t('desktopMigration.insert')}</Button><Button variant="outline" onClick={() => { void navigator.clipboard.writeText(JSON.stringify(draft, null, 2)).catch(() => setError(t('desktopMigration.copyFailed'))); }}>{t('desktopMigration.copy')}</Button><Button variant="ghost" onClick={() => dismiss(index)}>{t('desktopMigration.dismiss')}</Button></div>
      </section>)}
      {error && <p role="alert" className="text-destructive">{error}</p>}
    </DialogContent></Dialog>
  </>;
}
