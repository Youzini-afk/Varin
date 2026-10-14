import { useThreadAutoCleanup } from '@/hooks/useThreadAutoCleanup';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { usePwaManifestSync } from '@/hooks/usePwaManifestSync';
import { useWindowControlsOverlayLayout } from '@/hooks/useWindowControlsOverlayLayout';
export function ThreadAppEffects() {
  useThreadAutoCleanup();
  usePwaManifestSync();
  useWindowControlsOverlayLayout();
  useKeyboardShortcuts();
  return null;
}
