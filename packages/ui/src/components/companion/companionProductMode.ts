import {
  resolveVarinWorkbenchProfile, VARIN_WORKBENCH_BOT_PROFILE_ID, VARIN_WORKBENCH_DEFAULT_PROFILE_ID,
  VARIN_BUILTIN_BOT_WORKSPACE_EXTENSION_ID, VARIN_BUILTIN_AGENT_WORKSPACE_EXTENSION_ID,
  type VarinExtensionHostStateSnapshot,
} from '@varin/extension-contract';
import type { DirectorInteractionRoute } from './directorPresentation';

/** Product presentation mode, not a thread runtime or an inference from child work. */
export function companionProductMode(snapshot: VarinExtensionHostStateSnapshot | null): DirectorInteractionRoute {
  if (!snapshot?.workbench.authoritative || !snapshot.catalog.authoritative) return 'unknown';
  try {
    const resolved = resolveVarinWorkbenchProfile(snapshot.workbench.document, snapshot.catalog, { surface: 'desktop', userId: 'default' });
    if (resolved.status !== 'ready') return 'unknown';
    if (resolved.profileId === VARIN_WORKBENCH_BOT_PROFILE_ID && resolved.shellExtensionId === VARIN_BUILTIN_BOT_WORKSPACE_EXTENSION_ID) return 'bot-coordinator';
    if (resolved.profileId === VARIN_WORKBENCH_DEFAULT_PROFILE_ID && resolved.shellExtensionId === VARIN_BUILTIN_AGENT_WORKSPACE_EXTENSION_ID) return 'agent-companion';
  } catch { /* A partial or custom shell cannot prove either built-in product role. */ }
  return 'unknown';
}
