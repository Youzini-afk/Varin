import React from 'react';
import type { PluginCenterAPI } from '@varin/application-client';
import type { VarinExtensionReleasePreview } from '@varin/extension-contract';
import { getRuntimeEndpointGeneration } from '@varin/application-client';

/** Own only the currently selected read-only preview, not accepted installation work. */
export function usePluginReleasePreparation(api: PluginCenterAPI | undefined, hostId: string) {
  const [preview, setPreview] = React.useState<VarinExtensionReleasePreview | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string>();
  const retained = React.useRef<VarinExtensionReleasePreview | null>(null);
  const sequence = React.useRef(0);
  const mounted = React.useRef(true);
  const installing = React.useRef(false);
  const [generation] = React.useState(getRuntimeEndpointGeneration);
  const discard = React.useCallback((value: VarinExtensionReleasePreview | null) => {
    if (value) void api?.discard(value.previewId).catch(() => undefined);
  }, [api]);
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // This counter deliberately invalidates the latest request, not the request at effect setup.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      sequence.current++;
      if (!installing.current) discard(retained.current);
      retained.current = null;
    };
  }, [discard]);
  const close = React.useCallback(() => {
    sequence.current++; if (!installing.current) discard(retained.current);
    retained.current = null; setPreview(null); setBusy(null);
  }, [discard]);
  const prepare = React.useCallback(async (label: string, load: () => Promise<VarinExtensionReleasePreview>) => {
    if (installing.current) return;
    const request = ++sequence.current;
    discard(retained.current); retained.current = null; setPreview(null); setBusy(label); setError(undefined);
    try {
      const next = await load();
      if (!mounted.current || request !== sequence.current || generation !== getRuntimeEndpointGeneration() || next.hostId !== hostId) { discard(next); return; }
      retained.current = next; setPreview(next);
    } catch (failure) {
      if (mounted.current && request === sequence.current && generation === getRuntimeEndpointGeneration()) setError(failure instanceof Error ? failure.message : String(failure));
    } finally { if (mounted.current && request === sequence.current) setBusy(null); }
  }, [discard, generation, hostId]);
  return { preview, busy, error, prepare, close, setInstalling: (value: boolean) => { installing.current = value; } };
}
