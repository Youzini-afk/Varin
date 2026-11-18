import React from 'react';
import type { RuntimeAPIs } from '@varin/application-client';

import { SessionAuthGate } from '@/components/auth/SessionAuthGate';
import { ApplicationLoadingScreen } from '@/components/ui/ApplicationLoadingScreen';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';
import { isDesktopShell, restartDesktopApp } from '@/lib/desktop';
import { getBootInjectionStatus, getInjectedBootOutcome, resolveDesktopBootView, type DesktopBootView } from '@/lib/desktopBoot';
import { useI18n } from '@/lib/i18n';
import { dismissInitialSplash, setInitialSplashStatus } from '@/lib/splash';
import { VarinApplication } from './VarinApplication';

const Onboarding = lazyWithChunkRecovery(() => import('@/components/onboarding/OnboardingScreen')
  .then(module => ({ default: module.OnboardingScreen })));

const readBoot = () => {
  const status = getBootInjectionStatus();
  const view = status === 'valid' ? resolveDesktopBootView({ isDesktopShell: true, bootOutcome: getInjectedBootOutcome() }) : null;
  return { status, view };
};

type ConnectionView = Exclude<DesktopBootView, { screen: 'main' }>;

function DesktopConnection({ view }: { view: ConnectionView }) {
  // The surrounding Suspense boundary commits this effect only once the real
  // connection surface has loaded. There is intentionally no catalog/session.
  React.useEffect(() => {
    const scope = window as Window & { __varinStartupDiagnostics?: unknown; __varinAppReady?: boolean };
    scope.__varinStartupDiagnostics = { bootView: view, runtimeReady: false, catalogLoaded: false };
    dismissInitialSplash();
    if (!scope.__varinAppReady) {
      scope.__varinAppReady = true;
      window.dispatchEvent(new Event('varin:app-ready'));
    }
  }, [view]);
  return <Onboarding mode={view.screen === 'chooser' ? 'first-launch' : 'recovery'}
    localAvailable={view.localAvailable !== false}
    recoveryVariant={view.screen === 'recovery' ? view.variant : undefined}
    recoveryHostUrl={'url' in view ? view.url : undefined}
    onRuntimeAvailable={() => { void restartDesktopApp(); }} />;
}

function DesktopStartup({ apis }: { apis: RuntimeAPIs }) {
  const { t } = useI18n();
  const [{ status, view }, setBoot] = React.useState(readBoot);
  React.useEffect(() => {
    if (status === 'valid') return;
    if (status === 'malformed') {
      setInitialSplashStatus(t('splash.status.desktopFailed'));
      return;
    }
    // The shell can publish its final window-specific result after DOM ready.
    setInitialSplashStatus(t('splash.status.startingDesktop'));
    const poll = window.setInterval(() => {
      const next = readBoot();
      if (next.status !== 'not-injected') setBoot(next);
    }, 200);
    const slow = window.setTimeout(() => setInitialSplashStatus(t('splash.status.desktopSlow')), 10_000);
    return () => { window.clearInterval(poll); window.clearTimeout(slow); };
  }, [status, t]);
  if (!view) return <ApplicationLoadingScreen />;
  if (view.screen === 'main') return <SessionAuthGate apis={apis}><VarinApplication apis={apis} bootView={view} /></SessionAuthGate>;
  return (
    <RuntimeAPIContext.Provider value={apis}>
      <div className="h-full text-foreground bg-background">
        <React.Suspense fallback={<ApplicationLoadingScreen />}><DesktopConnection view={view} /></React.Suspense>
      </div>
    </RuntimeAPIContext.Provider>
  );
}

// Only the shell's connection picker/recovery is available without a Host.
// Neither workbench effects nor Host authentication start on those surfaces.
export function ApplicationStartup({ apis }: { apis: RuntimeAPIs }) {
  return isDesktopShell() ? <DesktopStartup apis={apis} /> :
    <SessionAuthGate apis={apis}><VarinApplication apis={apis} bootView={null} /></SessionAuthGate>;
}
