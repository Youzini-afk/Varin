import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/fonts'
import './styles/application'
import { VarinApplication } from './apps/VarinApplication'
import { SessionAuthGate } from './components/auth/SessionAuthGate'
import { ThemeSystemProvider } from './contexts/ThemeSystemContext'
import { ThemeProvider } from './components/providers/ThemeProvider'
import { MotionProvider } from './components/providers/MotionProvider'
import './lib/debug'
import { initializeAppearancePreferences } from './lib/persistence'
import { startAppearanceAutoSave } from './lib/appearanceAutoSave'
import { startTypographyWatcher } from './lib/typographyWatcher'
import { startModelPrefsAutoSave } from './lib/modelPrefsAutoSave'
import { initializeLocale, I18nProvider } from './lib/i18n'
import type { RuntimeAPIs } from '@varin/application-client'

declare global {
  interface Window {
    __VARIN_RUNTIME_APIS__?: RuntimeAPIs;
  }
}

const runtimeAPIs = (typeof window !== 'undefined' && window.__VARIN_RUNTIME_APIS__) || (() => {
  throw new Error('Varin runtime APIs were not provided.');
})();

initializeLocale();

// Initialize settings asynchronously — the app renders with defaults first
// and hydrates once persisted preferences are applied. Users with non-default
// themes may briefly see default appearance on cold start; accepted trade-off
// for faster time-to-first-paint.
void initializeAppearancePreferences().then(() => {
  // Server-backed settings and the authoritative workspace are restored by
  // SessionAuthGate only after authentication. Starting that work here sent
  // unauthenticated writes and let the Workbench mount against an unresolved
  // directory.
  startAppearanceAutoSave();
  startModelPrefsAutoSave();
  startTypographyWatcher();
}).catch((err) => {
  console.error('[main] appearance init failed:', err);
});


const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element not found');
}

createRoot(rootElement).render(
  <StrictMode>
    <I18nProvider>
      <ThemeSystemProvider>
        <ThemeProvider>
          <MotionProvider>
            <SessionAuthGate apis={runtimeAPIs}>
              <VarinApplication apis={runtimeAPIs} />
            </SessionAuthGate>
          </MotionProvider>
        </ThemeProvider>
      </ThemeSystemProvider>
    </I18nProvider>
  </StrictMode>,
);
