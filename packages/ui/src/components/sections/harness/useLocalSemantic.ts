import React from 'react';
import type { LocalSemanticStatus } from '@varin/protocol';
import { useI18n } from '@/lib/i18n';
import { getLocalSemanticStatus } from './local-semantic';

export type LocalSemanticState = {
  status: LocalSemanticStatus | null;
  error: string | null;
  busy: boolean;
  refresh: () => void;
  run: (action: () => Promise<void>, startsInstall?: boolean) => void;
};

export function useLocalSemantic(): LocalSemanticState {
  const { t } = useI18n();
  const [status, setStatus] = React.useState<LocalSemanticStatus | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const mounted = React.useRef(false);
  const generation = React.useRef(0);
  const request = React.useRef<AbortController | null>(null);

  const read = React.useCallback(async (expectedGeneration: number) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    try {
      const next = await getLocalSemanticStatus(controller.signal);
      if (!controller.signal.aborted && mounted.current && expectedGeneration === generation.current) {
        setStatus(next);
        setError(null);
      }
    } catch (failure) {
      if (!controller.signal.aborted && mounted.current && expectedGeneration === generation.current) {
        setError(failure instanceof Error && failure.message ? failure.message : t('settings.page.harness.localSemantic.requestFailed'));
      }
    } finally {
      if (request.current === controller) request.current = null;
    }
  }, [t]);

  React.useEffect(() => {
    mounted.current = true;
    const expectedGeneration = ++generation.current;
    void read(expectedGeneration);
    return () => {
      mounted.current = false;
      request.current?.abort();
      request.current = null;
      generation.current += 1;
    };
  }, [read]);

  React.useEffect(() => {
    if (status?.status !== 'installing' || busy) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      await read(generation.current);
      if (!cancelled && mounted.current) timer = setTimeout(() => { void poll(); }, 1500);
    };
    timer = setTimeout(() => { void poll(); }, 1500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [busy, read, status?.status]);

  const refresh = React.useCallback(() => {
    request.current?.abort();
    const expectedGeneration = ++generation.current;
    setError(null);
    void read(expectedGeneration);
  }, [read]);

  const run = React.useCallback((action: () => Promise<void>, startsInstall = false) => {
    request.current?.abort();
    const expectedGeneration = ++generation.current;
    const previous = status;
    setBusy(true);
    setError(null);
    if (startsInstall) setStatus({ status: 'installing', stage: 'downloading' });
    void (async () => {
      try {
        await action();
        if (!mounted.current || expectedGeneration !== generation.current) return;
        await read(expectedGeneration);
      } catch (failure) {
        if (!mounted.current || expectedGeneration !== generation.current) return;
        setStatus(previous);
        setError(failure instanceof Error && failure.message ? failure.message : t('settings.page.harness.localSemantic.requestFailed'));
      } finally {
        if (mounted.current && expectedGeneration === generation.current) setBusy(false);
      }
    })();
  }, [read, status, t]);

  return { status, error, busy, refresh, run };
}
