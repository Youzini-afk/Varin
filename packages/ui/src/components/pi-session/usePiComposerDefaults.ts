import React from 'react';
import {
  THINKING_LEVELS,
  type JsonValue,
  type PiSettingsSnapshot,
  type ThinkingLevel,
} from '@varin/protocol';
import { parseModelIdentifier } from '@/lib/modelIdentifier';
import { getPiSettings } from '@/lib/pi-runtime/settings';
import { getRuntimeKey } from '@varin/application-client';
import type { PiComposerModelSelection } from './piComposerSessionConfig';

export interface PiComposerDefaults {
  model?: PiComposerModelSelection;
  thinkingLevel?: ThinkingLevel;
}

const readString = (value: JsonValue | undefined): string | undefined => (
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
);

const isThinkingLevel = (value: string | undefined): value is ThinkingLevel => (
  value !== undefined && (THINKING_LEVELS as readonly string[]).includes(value)
);

export const resolvePiComposerDefaults = (
  snapshot: PiSettingsSnapshot | null,
  projectDefaultModel?: string,
): PiComposerDefaults => {
  const effectiveSettings = snapshot
    ? { ...snapshot.global, ...snapshot.project }
    : {};
  const settingsProvider = readString(effectiveSettings.defaultProvider);
  const settingsModel = readString(effectiveSettings.defaultModel);
  const projectModel = parseModelIdentifier(projectDefaultModel);
  const settingsThinking = readString(effectiveSettings.defaultThinkingLevel);

  const model = projectModel
    ? { id: projectModel.modelId, provider: projectModel.providerId }
    : settingsProvider && settingsModel
      ? { id: settingsModel, provider: settingsProvider }
      : undefined;

  return {
    ...(model ? { model } : {}),
    ...(isThinkingLevel(settingsThinking) ? { thinkingLevel: settingsThinking } : {}),
  };
};

export const usePiComposerDefaults = (
  cwd: string,
  projectDefaultModel?: string,
  runtimeKey = getRuntimeKey(),
): PiComposerDefaults & { loading: boolean } => {
  const [settings, setSettings] = React.useState<{ cwd: string; runtimeKey: string; snapshot: PiSettingsSnapshot | null } | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    if (!cwd.trim()) return () => { cancelled = true; };
    void getPiSettings({ cwd })
      .then((next) => {
        if (!cancelled) setSettings({ cwd, runtimeKey, snapshot: next });
      })
      .catch(() => {
        // Session creation still resolves the runtime defaults. The composer
        // keeps working when settings inspection is temporarily unavailable.
        if (!cancelled) setSettings({ cwd, runtimeKey, snapshot: null });
      });
    return () => { cancelled = true; };
  }, [cwd, runtimeKey]);

  return React.useMemo(
    () => ({
      ...resolvePiComposerDefaults(settings?.cwd === cwd && settings.runtimeKey === runtimeKey ? settings.snapshot : null, projectDefaultModel),
      loading: Boolean(cwd.trim()) && (settings?.cwd !== cwd || settings.runtimeKey !== runtimeKey),
    }),
    [cwd, projectDefaultModel, runtimeKey, settings],
  );
};
