import React from 'react';
import { isDesktopShell, restartDesktopApp, startDesktopWindowDrag } from '@/lib/desktop';
import { cn } from '@/lib/utils';
import { desktopHostsGet, desktopHostsSet } from '@/lib/desktopHosts';
import { useI18n } from '@/lib/i18n';
import { LocalRuntimeCard } from './LocalRuntimeCard';
import { RemoteConnectionForm } from './RemoteConnectionForm';

interface ChooserScreenProps {
  localAvailable?: boolean;
  onRuntimeAvailable?: () => void;
}

export function ChooserScreen({ onRuntimeAvailable, localAvailable = true }: ChooserScreenProps) {
  const { t } = useI18n();
  const [isDesktopApp, setIsDesktopApp] = React.useState(false);
  const [activeTab, setActiveTab] = React.useState<'local' | 'remote'>(() => (
    localAvailable ? 'local' : 'remote'
  ));

  React.useEffect(() => {
    setIsDesktopApp(isDesktopShell());
  }, []);

  React.useEffect(() => {
    if (!localAvailable) setActiveTab('remote');
  }, [localAvailable]);

  const handleDragStart = React.useCallback(async (event: React.MouseEvent) => {
    const target = event.target as HTMLElement;
    if (target.closest('.app-region-no-drag')) return;
    if (target.closest('button, a, input, select, textarea, summary, details')) return;
    if (event.button !== 0) return;
    if (isDesktopApp) await startDesktopWindowDrag();
  }, [isDesktopApp]);

  const useLocalRuntime = React.useCallback(async () => {
    if (isDesktopApp) {
      const config = await desktopHostsGet();
      await desktopHostsSet({
        ...config,
        defaultHostId: 'local',
        initialHostChoiceCompleted: true,
      });
      await restartDesktopApp();
      return;
    }
    onRuntimeAvailable?.();
  }, [isDesktopApp, onRuntimeAvailable]);

  const showLocal = localAvailable && (!isDesktopApp || activeTab === 'local');
  return (
    <div
      className="app-region-drag flex h-full cursor-default select-none items-center justify-center overflow-y-auto bg-transparent p-8"
      data-native-runtime-setup="true"
      onMouseDown={handleDragStart}
    >
      <div className="w-full max-w-md space-y-7">
        <header className="space-y-1.5 text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            {t('onboarding.chooser.title')}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t('onboarding.native.chooseDescription')}
          </p>
        </header>

        {isDesktopApp && localAvailable ? (
          <div className="app-region-no-drag flex gap-1.5">
            <button
              type="button"
              aria-pressed={activeTab === 'local'}
              className={cn(
                'flex-1 rounded-lg border px-4 py-2 text-sm transition-colors',
                activeTab === 'local'
                  ? 'border-[var(--interactive-selection)] bg-[var(--interactive-selection)]/10 text-foreground'
                  : 'border-border text-muted-foreground hover:border-muted-foreground hover:text-foreground',
              )}
              onClick={() => setActiveTab('local')}
            >
              {t('onboarding.chooser.tabs.localInstall')}
            </button>
            <button
              type="button"
              aria-pressed={activeTab === 'remote'}
              className={cn(
                'flex-1 rounded-lg border px-4 py-2 text-sm transition-colors',
                activeTab === 'remote'
                  ? 'border-[var(--interactive-selection)] bg-[var(--interactive-selection)]/10 text-foreground'
                  : 'border-border text-muted-foreground hover:border-muted-foreground hover:text-foreground',
              )}
              onClick={() => setActiveTab('remote')}
            >
              {t('onboarding.chooser.tabs.connectRemote')}
            </button>
          </div>
        ) : null}

        {isDesktopApp && activeTab === 'remote' ? (
          <div className="app-region-no-drag">
            <RemoteConnectionForm
              onBack={() => localAvailable && setActiveTab('local')}
              showBackButton={false}
              showInstancePicker={!localAvailable}
              onSwitchToLocal={localAvailable ? () => setActiveTab('local') : undefined}
            />
          </div>
        ) : null}

        {showLocal ? (
          <div className="space-y-4">
            <p className="text-center text-sm leading-relaxed text-muted-foreground">
              {t('onboarding.native.description')}
            </p>
            <LocalRuntimeCard onContinue={useLocalRuntime} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
