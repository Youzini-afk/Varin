import React from 'react';
import type { DesktopCompanionLibrary, DesktopCompanionLibraryAction } from '@varin/application-client';
import { Button } from '@/components/ui/button';
import { SwapText } from '@/components/motion/SwapText';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { invokeDesktop, isDesktopLocalOriginActive, isDesktopShell, subscribeDesktopCompanionLibrary } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import './companion-settings.css';

const size = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`;

export const CompanionSettings: React.FC = () => {
  const { t } = useI18n();
  const local = isDesktopShell() && isDesktopLocalOriginActive();
  const [library, setLibrary] = React.useState<DesktopCompanionLibrary | null>(null);
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState<string | null>(null);
  const sequence = React.useRef(0);
  const alive = React.useRef(false);
  const refresh = React.useCallback(async () => {
    const request = ++sequence.current;
    try {
      const next = await invokeDesktop('desktop_companion_library', { action: 'list' });
      if (alive.current && request === sequence.current && next) { setLibrary(next); setError(''); }
    } catch (cause) { if (alive.current && request === sequence.current) setError(cause instanceof Error ? cause.message : String(cause)); }
  }, []);
  React.useEffect(() => {
    if (!local) return;
    alive.current = true;
    let active = true;
    let dispose: (() => void) | undefined;
    void subscribeDesktopCompanionLibrary(() => { void refresh(); }).then(unlisten => {
      if (!active) unlisten(); else dispose = unlisten;
    }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
    void refresh();
    return () => { active = false; alive.current = false; sequence.current += 1; dispose?.(); };
  }, [local, refresh]);
  const run = async (id: string, operation: () => Promise<unknown>) => {
    setBusy(id); setError('');
    try { await operation(); await refresh(); }
    catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (alive.current) setBusy(null); }
  };
  const manage = (action: DesktopCompanionLibraryAction) => run('id' in action ? action.id : 'library', () => invokeDesktop('desktop_companion_library', action));
  const selected = library?.packs.find(pack => pack.id === library.selectedPackId);
  const awake = library?.visible === true;
  const storedBytes = library?.packs.reduce((sum, pack) => sum + pack.installedBytes + (pack.download?.receivedBytes ?? 0), 0) ?? 0;
  return <SettingsPageLayout title={t('companion.library.title')} description={t('companion.library.description')}>
    {!local ? <p className="typography-body text-muted-foreground">{t('companion.library.localOnly')}</p>
      : <>
        {error && <p role="alert" className="mb-5 break-words typography-meta text-status-error">{error}</p>}
        {!library ? <p className="typography-body text-muted-foreground">{error ? '' : t('companion.library.loading')}</p> : <>
          <div className="companion-presence" data-settings-item="sessions.desktop-companion">
            <div className="min-w-0 flex-1">
              <div className="mb-2 flex flex-wrap items-center gap-3"><h2 className="typography-title font-medium">{t('companion.library.presence')}</h2>
                <span className="companion-presence-status" data-awake={awake}><i /><SwapText text={t(awake ? 'companion.library.awake' : 'companion.library.asleep')} /></span></div>
              <p className="max-w-lg typography-meta leading-relaxed text-muted-foreground">{t(selected?.installedVersion ? 'companion.library.sleepNote' : 'companion.library.downloadNote')}</p>
            </div>
            <Button disabled={busy !== null || !selected?.installedVersion} variant={awake ? 'outline' : 'default'}
              onClick={() => { void run('presence', () => invokeDesktop('desktop_set_companion', { enabled: !awake })); }}>
              {t(awake ? 'companion.library.sleep' : 'companion.library.wake')}
            </Button>
          </div>
          <SettingsSection title={t('companion.library.appearances')}>
            <div className="companion-library">
              {library.packs.map(pack => {
                const installed = pack.installedVersion !== null, downloading = pack.download?.state === 'downloading';
                const chosen = pack.id === library.selectedPackId;
                return <article key={pack.id} className="companion-appearance" data-selected={chosen}>
                  <div className="companion-appearance-preview">
                    <img src={`/companion-previews/${encodeURIComponent(pack.id)}.png`} alt={pack.name} loading="lazy" draggable={false} />
                  </div>
                  <div className="companion-appearance-content">
                    <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="typography-title font-medium">{pack.name}</h3>
                      <span className="typography-meta text-muted-foreground">{t(chosen ? 'companion.library.selected' : installed ? 'companion.library.downloaded' : 'companion.library.notDownloaded')}</span></div>
                    <p className="mt-2 typography-meta text-muted-foreground">{t('companion.library.theme')}</p>
                    <p className="mt-1 max-w-lg typography-meta leading-relaxed text-muted-foreground">{t('companion.library.themeNote')}</p>
                    <div className="mt-4 typography-meta text-muted-foreground">{size(installed ? pack.installedBytes : pack.downloadBytes)}</div>
                    {pack.download && <div className="companion-download" aria-live="polite">
                      {downloading ? <>
                        <div className="flex flex-wrap justify-between gap-2 typography-meta"><span>{t('companion.library.downloading')}</span><span className="tabular-nums">{t('companion.library.progress', { received: size(pack.download.receivedBytes), total: size(pack.download.totalBytes) })}</span></div>
                        <div role="progressbar" aria-label={t('companion.library.downloading')} aria-valuemin={0} aria-valuemax={pack.download.totalBytes} aria-valuenow={pack.download.receivedBytes} className="companion-download-track">
                          <span style={{ transform: `scaleX(${pack.download.totalBytes ? pack.download.receivedBytes / pack.download.totalBytes : 0})` }} />
                        </div>
                      </> : <p className={`typography-meta break-words ${pack.download.state === 'failed' ? 'text-status-error' : 'text-muted-foreground'}`}>
                        {pack.download.error ?? t('companion.library.cancelled')}
                      </p>}
                    </div>}
                    <div className="mt-5 flex flex-wrap items-center gap-2">
                      {downloading ? <Button variant="outline" disabled={busy !== null} onClick={() => { void manage({ action: 'cancel', id: pack.id }); }}>{t('companion.library.cancel')}</Button>
                        : <>
                          {(!installed || pack.version !== pack.installedVersion) && <Button disabled={busy !== null} onClick={() => { void manage({ action: 'download', id: pack.id }); }}>{t(pack.download ? 'companion.library.retry' : installed ? 'companion.library.update' : 'companion.library.download')}</Button>}
                          {installed && !chosen && <Button disabled={busy !== null} onClick={() => { void manage({ action: 'select', id: pack.id }); }}>{t('companion.library.use')}</Button>}
                          {(installed || pack.download) && <Button variant="ghost" disabled={busy !== null} onClick={() => { void manage({ action: 'remove', id: pack.id }); }}>{t(installed ? 'companion.library.remove' : 'companion.library.clear')}</Button>}
                        </>}
                    </div>
                  </div>
                </article>;
              })}
            </div>
            <p className="mt-5 typography-meta text-muted-foreground">{t('companion.library.storage', { size: size(storedBytes) })}</p>
          </SettingsSection>
        </>}
      </>}
  </SettingsPageLayout>;
};
