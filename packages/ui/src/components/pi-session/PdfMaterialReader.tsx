import React from 'react';
import { getRuntimeKey, runtimeFetch } from '@varin/application-client';
import type { FetchResult } from '@varin/protocol';
import { PdfMaterialReader as Reader, type PdfMaterialReaderPort, type PdfMaterialReaderProps as ReaderProps } from '@/components/materials/PdfMaterialReader';
import { addPdfMaterialRegionToDraft } from '@/lib/pi-runtime/addPdfMaterialToDraft';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { useI18n } from '@/lib/i18n';

export type { PdfReaderLocation } from '@/components/materials/PdfMaterialReader';
export type PdfMaterialReaderProps = Omit<ReaderProps, 'reader'> & { sessionId: string | null };

const responseError = async (response: Response): Promise<string> => {
  const body = await response.json().catch(() => null) as unknown;
  if (body && typeof body === 'object') {
    if ('reason' in body && typeof body.reason === 'string') return body.reason;
    if ('error' in body && typeof body.error === 'string') return body.error;
    if ('message' in body && typeof body.message === 'string') return body.message;
  }
  return `${response.status} ${response.statusText}`.trim();
};

/** Pi owns only its session/transport/draft adapter; PDF interaction is shared. */
export const PdfMaterialReader: React.FC<PdfMaterialReaderProps> = ({ sessionId, ...props }) => {
  const { t } = useI18n();
  const currentSessionId = usePiSessionStore(state => state.currentSessionId);
  const runtimeKey = usePiSessionStore(state => state.runtimeKey);
  const reader = React.useMemo<PdfMaterialReaderPort>(() => {
    const isCurrent = () => Boolean(sessionId && usePiSessionStore.getState().currentSessionId === sessionId
      && usePiSessionStore.getState().runtimeKey === runtimeKey && getRuntimeKey() === runtimeKey);
    const unavailable = !sessionId ? t('harness.pdf.sessionMissing') : currentSessionId !== sessionId ? t('harness.pdf.sessionChanged') : undefined;
    const check = () => { if (!isCurrent()) throw new Error(unavailable || t('harness.pdf.sessionChanged')); };
    return {
      key: JSON.stringify([sessionId, currentSessionId, runtimeKey]), unavailable, isCurrent,
      async read(request, signal) {
        check();
        const response = await runtimeFetch(`/api/harness/sessions/${encodeURIComponent(sessionId!)}/materials/read`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal,
        });
        if (!response.ok) throw new Error(await responseError(response));
        const result = await response.json() as FetchResult;
        check(); signal?.throwIfAborted(); return result;
      },
      async readPage(snapshotId, page, scale, signal) {
        check();
        const query = new URLSearchParams({ page: String(page), scale: String(scale) });
        const response = await runtimeFetch(`/api/harness/sessions/${encodeURIComponent(sessionId!)}/materials/${encodeURIComponent(snapshotId)}/page?${query}`, { signal });
        if (!response.ok) throw new Error(await responseError(response));
        const blob = await response.blob(); check(); signal.throwIfAborted(); return blob;
      },
      addRegion(region) {
        check();
        const result = addPdfMaterialRegionToDraft({ ...region, sessionId: sessionId!, runtimeKey });
        if (result !== 'added') throw new Error(t(result === 'session-missing' ? 'harness.pdf.sessionMissing' : 'harness.pdf.sessionChanged'));
      },
    };
  }, [currentSessionId, runtimeKey, sessionId, t]);
  return <Reader key={reader.key} {...props} reader={reader} />;
};
