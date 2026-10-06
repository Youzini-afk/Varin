import React from 'react';
import { runtimeFetch } from '@varin/application-client';
import type {
  DocumentPageImage,
  DocumentReadRequest,
  DocumentOverview,
  FetchResult,
  WebDocumentRegion,
  WebSnapshotStructure,
} from '@varin/protocol';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { useI18n } from '@/lib/i18n';
import { getRuntimeKey } from '@varin/application-client';
import { addPdfMaterialRegionToDraft } from '@/lib/pi-runtime/addPdfMaterialToDraft';
import { normalizePdfMaterialRegion } from '@/lib/pi-runtime/pdfMaterialCitation';
import { usePiSessionStore } from '@/stores/usePiSessionStore';

type ReaderView = 'page' | 'text' | 'structure';
export type PdfReaderLocation = {
  page: number; view: ReaderView; scale: number; snapshotId: string; sourceHash: string;
};

export interface PdfMaterialReaderProps {
  sessionId: string | null;
  title: string;
  snapshotId?: string;
  path?: string;
  artifact?: { attemptId: string; artifactId: string };
  sourceHash?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  initialPage?: number;
  initialView?: ReaderView;
  initialScale?: number;
  onLocationChange?: (location: PdfReaderLocation) => void;
  initialRegion?: WebDocumentRegion;
  analysisId?: string;
  originalUrl?: string;
  presentation?: 'dialog' | 'inline';
  onOpenOriginal?: () => void;
}

type PdfReadOk = Extract<FetchResult, { status: 'ok' }>;
type ReaderActionContext = {
  controller: AbortController;
  generation: number;
  runtimeKey: string;
  sessionId: string | null;
  snapshotId: string;
  page: number;
};

const readError = (result: FetchResult): string => {
  if ('reason' in result && typeof result.reason === 'string') return result.reason;
  if ('detail' in result && typeof result.detail === 'string' && result.detail) return result.detail;
  if ('hint' in result && typeof result.hint === 'string' && result.hint) return result.hint;
  if (result.status === 'structure-unsupported') return `${result.status}: ${result.kind}`;
  if (result.status === 'redirect-cross-host') return `${result.status}: ${result.location}`;
  return result.status;
};

const responseError = async (response: Response): Promise<string> => {
  const body = await response.json().catch(() => null) as unknown;
  if (body && typeof body === 'object') {
    if ('reason' in body && typeof body.reason === 'string') return body.reason;
    if ('error' in body && typeof body.error === 'string') return body.error;
    if ('message' in body && typeof body.message === 'string') return body.message;
  }
  return `${response.status} ${response.statusText}`.trim();
};

const maxKnownPage = (overview: DocumentOverview | null): number | undefined => {
  if (overview?.pageCount && overview.pageCount > 0) return overview.pageCount;
  const pages = overview?.pages ?? [];
  return pages.length ? Math.max(...pages.map((entry) => entry.page)) : undefined;
};

const pageImageData = (result: PdfReadOk, page: number): DocumentPageImage | null => {
  const exact = result.pageImages?.find((image) => image.page === page);
  if (exact) return exact;
  if (!result.pageImage || result.pageImage.page !== page) return null;
  return {
    ...result.pageImage,
    width: 0,
    height: 0,
    sourceHash: result.overview?.sourceHash ?? result.snapshot?.document?.source?.contentHash ?? '',
  };
};

const regionStyle = (region: WebDocumentRegion): React.CSSProperties => ({
  left: `${region.x * 100}%`,
  top: `${region.y * 100}%`,
  width: `${region.width * 100}%`,
  height: `${region.height * 100}%`,
});

type CellTableView = {
  id: string;
  cells?: NonNullable<NonNullable<WebSnapshotStructure['elements']>[number]['cells']>;
  rows?: NonNullable<NonNullable<WebSnapshotStructure['tables']>[number]['rows']>;
};

const cellTables = (structure: WebSnapshotStructure | null): CellTableView[] => {
  if (!structure) return [];
  const parsed = (structure.elements ?? [])
    .filter((element) => element.kind === 'table' && (element.cells?.length ?? 0) > 0)
    .map((element) => ({ id: element.id, cells: element.cells }));
  if (parsed.length > 0) return parsed;
  return (structure.tables ?? []).map((table, index) => ({
    id: table.elementId ?? `table-${index}`,
    ...(table.cells ? { cells: table.cells } : {}),
    ...(table.rows ? { rows: table.rows } : {}),
  }));
};

const hasCellData = (structure: WebSnapshotStructure | null): boolean => (
  cellTables(structure).some((table) => (table.cells?.length ?? 0) > 0 || (table.rows?.some((row) => row.cells.length > 0) ?? false))
);

export const PdfMaterialReader: React.FC<PdfMaterialReaderProps> = ({
  sessionId,
  title,
  snapshotId: inputSnapshotId,
  path,
  artifact,
  sourceHash: inputSourceHash,
  open = true,
  onOpenChange,
  initialPage = 1,
  initialView = 'page',
  initialScale = 1,
  onLocationChange,
  initialRegion,
  originalUrl,
  presentation = 'dialog',
  onOpenOriginal,
}) => {
  const { t } = useI18n();
  const artifactAttemptId = artifact?.attemptId;
  const artifactId = artifact?.artifactId;
  const hasInitialRegion = initialRegion !== undefined;
  const initialRegionX = initialRegion?.x;
  const initialRegionY = initialRegion?.y;
  const initialRegionWidth = initialRegion?.width;
  const initialRegionHeight = initialRegion?.height;
  const artifactReference = React.useMemo(() => (
    artifactAttemptId && artifactId ? { attemptId: artifactAttemptId, artifactId } : undefined
  ), [artifactAttemptId, artifactId]);
  const initialRegionValue = React.useMemo(() => (
    hasInitialRegion && initialRegionX !== undefined && initialRegionY !== undefined
      && initialRegionWidth !== undefined && initialRegionHeight !== undefined ? {
      x: initialRegionX,
      y: initialRegionY,
      width: initialRegionWidth,
      height: initialRegionHeight,
    } : undefined
  ), [hasInitialRegion, initialRegionHeight, initialRegionWidth, initialRegionX, initialRegionY]);
  const currentSessionId = usePiSessionStore((state) => state.currentSessionId);
  const runtimeKey = usePiSessionStore((state) => state.runtimeKey);
  const [currentSnapshotId, setCurrentSnapshotId] = React.useState(inputSnapshotId ?? '');
  const [currentSourceHash, setCurrentSourceHash] = React.useState(inputSourceHash ?? '');
  const [overview, setOverview] = React.useState<DocumentOverview | null>(null);
  const [text, setText] = React.useState('');
  const [structure, setStructure] = React.useState<WebSnapshotStructure | null>(null);
  const [page, setPage] = React.useState(Math.max(1, initialPage));
  const [pageDraft, setPageDraft] = React.useState(String(Math.max(1, initialPage)));
  const [view, setView] = React.useState<ReaderView>(initialView);
  const [scale, setScale] = React.useState(initialScale);
  const restoreTextRef = React.useRef(initialView === 'text');
  const onLocationChangeRef = React.useRef(onLocationChange);
  onLocationChangeRef.current = onLocationChange;
  const [pageSrc, setPageSrc] = React.useState('');
  const [pageLoading, setPageLoading] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [analysisBusy, setAnalysisBusy] = React.useState(false);
  const [structureScope, setStructureScope] = React.useState<'page' | 'document'>('page');
  const [searchText, setSearchText] = React.useState('');
  const [findHits, setFindHits] = React.useState<PdfReadOk['findHits']>([]);
  const [selectedRegion, setSelectedRegion] = React.useState<WebDocumentRegion | null>(initialRegion ?? null);
  const [selectedRegionPage, setSelectedRegionPage] = React.useState<number | null>(initialRegion ? Math.max(1, initialPage) : null);
  const [selecting, setSelecting] = React.useState<{ x: number; y: number } | null>(null);
  const [failure, setFailure] = React.useState('');
  const [notice, setNotice] = React.useState('');
  const pageImageRef = React.useRef<HTMLImageElement | null>(null);
  const pageViewportRef = React.useRef<HTMLDivElement | null>(null);
  const sourceGenerationRef = React.useRef(0);
  const actionControllerRef = React.useRef<AbortController | null>(null);
  const [textPage, setTextPage] = React.useState<number | null>(null);
  const [viewportSize, setViewportSize] = React.useState({ width: 0, height: 0 });
  const [pageRaster, setPageRaster] = React.useState<{ page: number; width: number; height: number; scale: number } | null>(null);
  const canRead = Boolean(sessionId && currentSessionId === sessionId);
  React.useEffect(() => {
    if (canRead && currentSnapshotId && !loading) onLocationChangeRef.current?.({
      page, view, scale, snapshotId: currentSnapshotId, sourceHash: currentSourceHash,
    });
  }, [canRead, currentSnapshotId, currentSourceHash, loading, page, scale, view]);

  const requestRead = React.useCallback(async (
    request: DocumentReadRequest,
    signal?: AbortSignal,
  ): Promise<FetchResult> => {
    if (!sessionId) throw new Error(t('harness.pdf.sessionMissing'));
    if (currentSessionId !== sessionId
      || usePiSessionStore.getState().runtimeKey !== runtimeKey
      || getRuntimeKey() !== runtimeKey) throw new Error(t('harness.pdf.sessionChanged'));
    const response = await runtimeFetch(
      `/api/harness/sessions/${encodeURIComponent(sessionId)}/materials/read`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        ...(signal ? { signal } : {}),
      },
    );
    if (!response.ok) throw new Error(await responseError(response));
    return await response.json() as FetchResult;
  }, [currentSessionId, runtimeKey, sessionId, t]);

  const updateSnapshotFrom = React.useCallback((result: PdfReadOk) => {
    const returnedHash = result.overview?.sourceHash
      ?? result.pageImages?.[0]?.sourceHash
      ?? result.snapshot?.document?.source?.contentHash
      ?? result.sourceSnapshot?.document?.source?.contentHash;
    const expectedHash = inputSourceHash || currentSourceHash;
    if (expectedHash && returnedHash && returnedHash !== expectedHash) {
      throw new Error(t('harness.pdf.sourceHashMismatch'));
    }
    if (result.snapshot?.snapshotId) setCurrentSnapshotId(result.snapshot.snapshotId);
    if (returnedHash) setCurrentSourceHash(returnedHash);
    else if (inputSourceHash && !currentSourceHash) throw new Error(t('harness.pdf.sourceHashUnavailable'));
  }, [currentSourceHash, inputSourceHash, t]);

  React.useEffect(() => {
    if (!open) return;
    const generation = ++sourceGenerationRef.current;
    actionControllerRef.current?.abort();
    actionControllerRef.current = null;
    const controller = new AbortController();
    const requestRuntimeKey = runtimeKey;
    const isCurrent = () => !controller.signal.aborted
      && sourceGenerationRef.current === generation
      && usePiSessionStore.getState().runtimeKey === requestRuntimeKey
      && getRuntimeKey() === requestRuntimeKey
      && usePiSessionStore.getState().currentSessionId === sessionId;
    setCurrentSnapshotId('');
    setCurrentSourceHash('');
    setOverview(null);
    setText('');
    setTextPage(null);
    setStructure(null);
    setPageRaster(null);
    setCellsView(false);
    setStructureScope('page');
    setScale(initialScale);
    restoreTextRef.current = initialView === 'text';
    setSearchText('');
    setPageSrc('');
    setPageLoading(false);
    setAnalysisBusy(false);
    setFindHits([]);
    setFailure('');
    setNotice('');
    setSelectedRegion(initialRegionValue ?? null);
    setSelectedRegionPage(initialRegionValue ? Math.max(1, initialPage) : null);
    setPage(Math.max(1, initialPage));
    setPageDraft(String(Math.max(1, initialPage)));
    setView(initialView);
    if (!sessionId) {
      setFailure(t('harness.pdf.sessionMissing'));
      return () => controller.abort();
    }
    if (currentSessionId !== sessionId) {
      setFailure(t('harness.pdf.sessionChanged'));
      return () => controller.abort();
    }
    if (!inputSnapshotId && !path && !artifactReference) {
      setFailure(t('harness.pdf.sourceUnavailable'));
      return () => controller.abort();
    }
    setLoading(true);
    const request: DocumentReadRequest = {
      ...(inputSnapshotId ? { snapshotId: inputSnapshotId } : artifactReference ? { artifact: artifactReference } : { path }),
      view: 'overview',
    };
    void requestRead(request, controller.signal).then((result) => {
      if (!isCurrent()) return;
      if (result.status !== 'ok') {
        setFailure(readError(result));
        return;
      }
      const actualSourceHash = result.overview?.sourceHash ?? result.snapshot?.document?.source?.contentHash ?? '';
      if (inputSourceHash && actualSourceHash !== inputSourceHash) {
        setFailure(actualSourceHash
          ? t('harness.pdf.sourceHashMismatch')
          : t('harness.pdf.sourceHashUnavailable'));
        return;
      }
      const resolvedId = result.snapshot?.snapshotId ?? inputSnapshotId ?? '';
      if (!resolvedId) {
        setFailure(t('harness.pdf.sourceUnavailable'));
        return;
      }
      if (!result.overview) {
        setFailure(t('harness.pdf.sourceUnavailable'));
        return;
      }
      setOverview(result.overview ?? null);
      setStructure(result.structure ?? result.snapshot?.structure ?? null);
      setText(result.markdown ?? '');
      setFindHits(result.findHits ?? []);
      setCurrentSourceHash(actualSourceHash);
      setCurrentSnapshotId(resolvedId);
      const analysis = result.analysis ?? result.snapshot?.document?.analysis;
      setTextPage(result.markdown !== undefined && analysis?.pages.length === 1 ? analysis.pages[0]! : null);
      setPage(Math.max(1, initialPage));
      setPageDraft(String(Math.max(1, initialPage)));
    }).catch((error) => {
      if (isCurrent()) {
        setFailure(error instanceof Error ? error.message : String(error));
      }
    }).finally(() => {
      if (isCurrent()) setLoading(false);
    });
    return () => {
      controller.abort();
      actionControllerRef.current?.abort();
      actionControllerRef.current = null;
      if (sourceGenerationRef.current === generation) sourceGenerationRef.current += 1;
    };
  }, [
    artifactReference,
    currentSessionId,
    initialPage,
    initialScale,
    initialView,
    initialRegionValue,
    inputSnapshotId,
    inputSourceHash,
    open,
    path,
    requestRead,
    runtimeKey,
    sessionId,
    t,
  ]);

  React.useEffect(() => {
    if (!open || view !== 'page' || !currentSnapshotId || !overview || !canRead) return;
    const controller = new AbortController();
    const requestRuntimeKey = runtimeKey;
    let nextSrc = '';
    setPageLoading(true);
    setPageSrc('');
    setPageRaster(null);
    const query = new URLSearchParams({ page: String(page), scale: String(scale) });
    const route = `/api/harness/sessions/${encodeURIComponent(sessionId!)}/materials/${encodeURIComponent(currentSnapshotId)}/page?${query.toString()}`;
    void runtimeFetch(route, { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error(await responseError(response));
      const blob = await response.blob();
      if (!blob.type.startsWith('image/')) throw new Error(t('harness.pdf.pageImageUnavailable'));
      nextSrc = URL.createObjectURL(blob);
      if (controller.signal.aborted
        || usePiSessionStore.getState().runtimeKey !== requestRuntimeKey
        || getRuntimeKey() !== requestRuntimeKey
        || usePiSessionStore.getState().currentSessionId !== sessionId) {
        URL.revokeObjectURL(nextSrc);
        nextSrc = '';
        return;
      }
      setPageSrc(nextSrc);
    }).catch((error) => {
      if (!controller.signal.aborted
        && usePiSessionStore.getState().runtimeKey === requestRuntimeKey
        && getRuntimeKey() === requestRuntimeKey
        && usePiSessionStore.getState().currentSessionId === sessionId) {
        setPageSrc('');
        setFailure(error instanceof Error ? error.message : String(error));
      }
    }).finally(() => {
      if (!controller.signal.aborted
        && usePiSessionStore.getState().runtimeKey === requestRuntimeKey
        && getRuntimeKey() === requestRuntimeKey
        && usePiSessionStore.getState().currentSessionId === sessionId) setPageLoading(false);
    });
    return () => {
      controller.abort();
      if (nextSrc) URL.revokeObjectURL(nextSrc);
    };
  }, [canRead, currentSnapshotId, open, overview, page, runtimeKey, scale, sessionId, t, view]);

  React.useEffect(() => {
    const viewport = pageViewportRef.current;
    if (!open || view !== 'page' || !viewport) return;
    const measure = () => {
      const style = typeof window.getComputedStyle === 'function' ? window.getComputedStyle(viewport) : null;
      const horizontalPadding = style ? Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight) : 0;
      const verticalPadding = style ? Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom) : 0;
      const width = Math.max(0, viewport.clientWidth - (Number.isFinite(horizontalPadding) ? horizontalPadding : 0));
      const height = Math.max(0, viewport.clientHeight - (Number.isFinite(verticalPadding) ? verticalPadding : 0));
      setViewportSize((current) => current.width === width && current.height === height ? current : { width, height });
    };
    measure();
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(measure);
      observer.observe(viewport);
      return () => observer.disconnect();
    }
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open, view]);

  React.useEffect(() => {
    setPageDraft(String(page));
  }, [page]);

  const beginAction = React.useCallback((): ReaderActionContext => {
    actionControllerRef.current?.abort();
    const controller = new AbortController();
    actionControllerRef.current = controller;
    return {
      controller,
      generation: sourceGenerationRef.current,
      runtimeKey,
      sessionId,
      snapshotId: currentSnapshotId,
      page,
    };
  }, [currentSnapshotId, page, runtimeKey, sessionId]);

  const isActionCurrent = React.useCallback((
    action: ReaderActionContext,
    bindPage = false,
    checkSnapshot = true,
  ): boolean => {
    const store = usePiSessionStore.getState();
    return !action.controller.signal.aborted
      && sourceGenerationRef.current === action.generation
      && store.runtimeKey === action.runtimeKey
      && getRuntimeKey() === action.runtimeKey
      && store.currentSessionId === action.sessionId
      && action.sessionId === sessionId
      && (!checkSnapshot || action.snapshotId === currentSnapshotId)
      && (!bindPage || action.page === page);
  }, [currentSnapshotId, page, sessionId]);

  const finishAction = React.useCallback((action: ReaderActionContext) => {
    if (actionControllerRef.current !== action.controller) return;
    actionControllerRef.current = null;
  }, []);

  const navigateToPage = React.useCallback((nextPage: number, region?: WebDocumentRegion) => {
    const maximum = maxKnownPage(overview);
    const target = Math.max(1, Math.min(Math.trunc(nextPage), maximum ?? Math.trunc(nextPage)));
    if (target !== page) {
      actionControllerRef.current?.abort();
      actionControllerRef.current = null;
      setLoading(false);
      setAnalysisBusy(false);
      setSelectedRegion(null);
      setSelectedRegionPage(null);
      setSelecting(null);
    }
    setPage(target);
    setFailure('');
    if (region) {
      setSelectedRegion(region);
      setSelectedRegionPage(target);
    }
    setView('page');
  }, [overview, page]);

  const jumpToPage = React.useCallback(() => {
    const parsed = Number(pageDraft);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
      setPageDraft(String(page));
      return;
    }
    navigateToPage(parsed);
    setFailure('');
  }, [navigateToPage, page, pageDraft]);

  const search = React.useCallback(async () => {
    const query = searchText.trim();
    if (!query || !currentSnapshotId) return;
    const action = beginAction();
    setLoading(true);
    setFailure('');
    setNotice('');
    try {
      const result = await requestRead({ snapshotId: currentSnapshotId, view: 'text', pages: 'all', find: query }, action.controller.signal);
      if (!isActionCurrent(action)) return;
      if (result.status !== 'ok') throw new Error(readError(result));
      updateSnapshotFrom(result);
      setText(result.markdown);
      setTextPage(null);
      setStructure(result.structure ?? structure);
      setFindHits(result.findHits ?? []);
      setView('text');
    } catch (error) {
      if (isActionCurrent(action, false, false)) setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      if (isActionCurrent(action, false, false)) setLoading(false);
      finishAction(action);
    }
  }, [beginAction, currentSnapshotId, finishAction, isActionCurrent, requestRead, searchText, structure, updateSnapshotFrom]);

  const loadText = React.useCallback(async () => {
    setView('text');
    if ((text && textPage === page) || !currentSnapshotId) return;
    const action = beginAction();
    setLoading(true);
    setFailure('');
    try {
      const result = await requestRead({ snapshotId: currentSnapshotId, view: 'text', pages: [page] }, action.controller.signal);
      if (!isActionCurrent(action, true)) return;
      if (result.status !== 'ok') throw new Error(readError(result));
      updateSnapshotFrom(result);
      setText(result.markdown);
      setTextPage(page);
      setStructure(result.structure ?? structure);
    } catch (error) {
      if (isActionCurrent(action, true, false)) setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      if (isActionCurrent(action, true, false)) setLoading(false);
      finishAction(action);
    }
  }, [beginAction, currentSnapshotId, finishAction, isActionCurrent, page, requestRead, structure, text, textPage, updateSnapshotFrom]);

  React.useEffect(() => {
    if (!restoreTextRef.current || !currentSnapshotId || loading) return;
    restoreTextRef.current = false;
    void loadText();
  }, [currentSnapshotId, loadText, loading]);

  const runCurrentPageOcr = React.useCallback(async () => {
    if (!currentSnapshotId) return;
    const action = beginAction();
    setLoading(true);
    setFailure('');
    setNotice('');
    try {
      const result = await requestRead({
        snapshotId: currentSnapshotId,
        view: 'text',
        pages: [page],
        parser: 'native',
        ocr: true,
      }, action.controller.signal);
      if (!isActionCurrent(action, true)) return;
      if (result.status !== 'ok') throw new Error(readError(result));
      updateSnapshotFrom(result);
      setText(result.markdown);
      setTextPage(page);
      setStructure(result.structure ?? structure);
      setFindHits(result.findHits ?? []);
      setView('text');
      if (result.ocr?.status === 'unavailable') {
        setFailure(result.ocr.detail || t('harness.pdf.ocrUnavailable'));
      } else if (result.ocr?.status === 'used') {
        setNotice(result.ocr.detail || t('harness.pdf.ocrUsed'));
      } else if (result.ocr?.status === 'not-needed') {
        setNotice(t('harness.pdf.ocrNotNeeded'));
      }
    } catch (error) {
      if (isActionCurrent(action, true, false)) setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      if (isActionCurrent(action, true, false)) setLoading(false);
      finishAction(action);
    }
  }, [beginAction, currentSnapshotId, finishAction, isActionCurrent, page, requestRead, structure, t, updateSnapshotFrom]);

  const analyzeStructure = React.useCallback(async () => {
    if (!currentSnapshotId) return;
    const action = beginAction();
    setAnalysisBusy(true);
    setFailure('');
    setNotice('');
    try {
      const result = await requestRead({
        snapshotId: currentSnapshotId,
        view: 'structure',
        parser: 'docling',
        pages: structureScope === 'page' ? [page] : 'all',
      }, action.controller.signal);
      if (!isActionCurrent(action, structureScope === 'page')) return;
      if (result.status !== 'ok') throw new Error(readError(result));
      updateSnapshotFrom(result);
      setStructure(result.structure ?? null);
      if (result.markdown !== undefined) {
        setText(result.markdown);
        const analysis = result.analysis ?? result.snapshot?.document?.analysis;
        setTextPage(analysis?.pages.length === 1
          ? analysis.pages[0]!
          : structureScope === 'page' ? page : null);
      }
      setFindHits(result.findHits ?? []);
      setView('structure');
      if (result.analysis?.status === 'unavailable') {
        const reason = result.structure?.unparsed?.filter(Boolean).join(' · ') || result.analysis.status;
        setFailure(t('harness.pdf.analysisUnavailable', { reason }));
      } else if (result.ocr?.status === 'unavailable') {
        setFailure(result.ocr.detail || t('harness.pdf.ocrUnavailable'));
      }
    } catch (error) {
      if (isActionCurrent(action, structureScope === 'page')) {
        setFailure(error instanceof Error ? error.message : String(error));
        setView('structure');
      }
    } finally {
      if (isActionCurrent(action, structureScope === 'page', false)) setAnalysisBusy(false);
      finishAction(action);
    }
  }, [beginAction, currentSnapshotId, finishAction, isActionCurrent, page, requestRead, structureScope, t, updateSnapshotFrom]);

  const selectFindHit = React.useCallback((hit: NonNullable<PdfReadOk['findHits']>[number]) => {
    navigateToPage(hit.page, hit.region);
    if (!hit.region) {
      setSelectedRegion(null);
      setSelectedRegionPage(null);
    }
    setNotice(hit.region ? '' : t('harness.pdf.hitHasNoRegion'));
  }, [navigateToPage, t]);

  const pointerCoordinate = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const image = pageImageRef.current;
    if (!image) return null;
    const bounds = image.getBoundingClientRect();
    return {
      x: Math.max(bounds.left, Math.min(bounds.right, event.clientX)),
      y: Math.max(bounds.top, Math.min(bounds.bottom, event.clientY)),
    };
  }, []);

  const beginSelection = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !pageSrc || view !== 'page') return;
    const point = pointerCoordinate(event);
    if (!point) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setSelecting(point);
    setSelectedRegion(null);
    setSelectedRegionPage(null);
    setNotice('');
  }, [pageSrc, pointerCoordinate, view]);

  const finishSelection = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!selecting) return;
    const point = pointerCoordinate(event);
    if (!point) {
      setSelecting(null);
      return;
    }
    const image = pageImageRef.current;
    if (!image) return;
    const region = normalizePdfMaterialRegion(selecting, point, image.getBoundingClientRect());
    setSelecting(null);
    if (region) {
      setSelectedRegion(region);
      setSelectedRegionPage(page);
    }
  }, [page, pointerCoordinate, selecting]);

  const askAboutSelection = React.useCallback(async () => {
    if (!sessionId || !currentSnapshotId || !selectedRegion || selectedRegionPage !== page) return;
    if (!currentSourceHash) {
      setFailure(t('harness.pdf.sourceHashUnavailable'));
      return;
    }
    const action = beginAction();
    setLoading(true);
    setFailure('');
    setNotice('');
    try {
      const result = await requestRead({
        snapshotId: currentSnapshotId,
        view: 'page-image',
        page,
        region: selectedRegion,
        scale,
      }, action.controller.signal);
      if (!isActionCurrent(action, true) || selectedRegionPage !== action.page) return;
      if (result.status !== 'ok') throw new Error(readError(result));
      updateSnapshotFrom(result);
      const image = pageImageData(result, page);
      if (!image?.data) throw new Error(t('harness.pdf.pageImageUnavailable'));
      const sourceHash = image.sourceHash || result.overview?.sourceHash || currentSourceHash;
      if (sourceHash !== currentSourceHash || (inputSourceHash && sourceHash !== inputSourceHash)) {
        throw new Error(t('harness.pdf.sourceHashMismatch'));
      }
      const citedRegion = image.region ?? selectedRegion;
      const analysisIdForResult = result.analysis?.id ?? result.snapshot?.document?.analysis?.id;
      const added = addPdfMaterialRegionToDraft({
        sessionId,
        snapshotId: result.snapshot?.snapshotId ?? currentSnapshotId,
        title,
        page,
        sourceHash,
        region: citedRegion,
        image: { data: image.data, mimeType: image.mimeType },
        ...(analysisIdForResult ? { analysisId: analysisIdForResult } : {}),
        runtimeKey: action.runtimeKey,
      });
      if (!isActionCurrent(action, true, false)) return;
      if (added === 'session-missing') setFailure(t('harness.pdf.sessionMissing'));
      else if (added === 'session-changed') setFailure(t('harness.pdf.sessionChanged'));
      else if (added === 'runtime-changed') return;
      else {
        setNotice(t('harness.pdf.addedToDraft'));
        if (presentation === 'dialog') onOpenChange?.(false);
      }
    } catch (error) {
      if (isActionCurrent(action, true, false)) setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      if (isActionCurrent(action, true, false)) setLoading(false);
      finishAction(action);
    }
  }, [
    beginAction,
    currentSnapshotId,
    currentSourceHash,
    finishAction,
    inputSourceHash,
    isActionCurrent,
    onOpenChange,
    page,
    presentation,
    requestRead,
    scale,
    selectedRegion,
    selectedRegionPage,
    sessionId,
    t,
    title,
    updateSnapshotFrom,
  ]);

  const tablesWithCells = cellTables(structure);
  const hasTableCells = hasCellData(structure);
  const [cellsView, setCellsView] = React.useState(false);
  const displayPageSize = React.useMemo(() => {
    if (!pageRaster || pageRaster.page !== page || pageRaster.scale <= 0) return null;
    const baseWidth = pageRaster.width / pageRaster.scale;
    const baseHeight = pageRaster.height / pageRaster.scale;
    if (baseWidth <= 0 || baseHeight <= 0) return null;
    const fitWidth = viewportSize.width > 0 ? viewportSize.width / baseWidth : 1;
    const fitHeight = viewportSize.height > 0 ? viewportSize.height / baseHeight : 1;
    const fitScale = Math.min(fitWidth, fitHeight);
    return { width: baseWidth * fitScale * scale, height: baseHeight * fitScale * scale };
  }, [page, pageRaster, scale, viewportSize.height, viewportSize.width]);
  const sourceOpenUrl = originalUrl?.trim() || '';
  const openOriginal = React.useCallback(() => {
    if (onOpenOriginal) {
      onOpenOriginal();
      return;
    }
    if (sourceOpenUrl) window.open(sourceOpenUrl, '_blank', 'noopener,noreferrer');
  }, [onOpenOriginal, sourceOpenUrl]);

  const readerContent = (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-border/50 px-3 py-2">
        <div className="flex items-center gap-1" role="tablist" aria-label={t('harness.pdf.views')}>
          <Button type="button" size="xs" variant={view === 'page' ? 'secondary' : 'ghost'} aria-pressed={view === 'page'} onClick={() => { setView('page'); setFailure(''); }}>
            {t('harness.pdf.pageView')}
          </Button>
          <Button type="button" size="xs" variant={view === 'text' ? 'secondary' : 'ghost'} aria-pressed={view === 'text'} onClick={() => { void loadText(); }}>
            {t('harness.pdf.textView')}
          </Button>
          <Button type="button" size="xs" variant={view === 'structure' ? 'secondary' : 'ghost'} aria-pressed={view === 'structure'} onClick={() => setView('structure')}>
            {t('harness.pdf.structureView')}
          </Button>
        </div>
        <div className="ml-auto flex items-center gap-1">
          <form className="flex items-center gap-1" onSubmit={(event) => { event.preventDefault(); void search(); }}>
            <label className="sr-only" htmlFor="pdf-material-search">{t('harness.pdf.search')}</label>
            <input
              id="pdf-material-search"
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
              placeholder={t('harness.pdf.searchPlaceholder')}
              className="h-7 w-36 rounded-md border border-border bg-background px-2 text-xs outline-none focus:border-primary sm:w-48"
            />
            <Button type="submit" size="xs" variant="ghost" aria-label={t('harness.pdf.search')} disabled={!searchText.trim() || loading || !currentSnapshotId}>
              <Icon name="search" className="size-4" />
            </Button>
          </form>
          {path || sourceOpenUrl ? (
            <Button type="button" size="xs" variant="ghost" onClick={openOriginal}>
              {t('harness.pdf.openOriginal')}
            </Button>
          ) : null}
        </div>
      </div>

      {view === 'page' ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex flex-wrap items-center justify-center gap-2 border-b border-border/40 px-3 py-1.5">
            <Button type="button" size="xs" variant="ghost" aria-label={t('harness.pdf.previousPage')} disabled={page <= 1} onClick={() => navigateToPage(page - 1)}>‹</Button>
            <form className="flex items-center gap-1 text-xs" onSubmit={(event) => { event.preventDefault(); jumpToPage(); }}>
              <label htmlFor="pdf-material-page" className="sr-only">{t('harness.pdf.goToPage')}</label>
              <input
                id="pdf-material-page"
                inputMode="numeric"
                value={pageDraft}
                onChange={(event) => setPageDraft(event.target.value)}
                onBlur={jumpToPage}
                className="h-7 w-14 rounded border border-border bg-background px-1 text-center tabular-nums"
              />
              <span className="text-muted-foreground">/ {maxKnownPage(overview) ?? '—'}</span>
            </form>
            <Button type="button" size="xs" variant="ghost" aria-label={t('harness.pdf.nextPage')} disabled={maxKnownPage(overview) !== undefined && page >= maxKnownPage(overview)!} onClick={() => navigateToPage(page + 1)}>›</Button>
            <span className="mx-1 h-4 w-px bg-border/60" />
            <Button type="button" size="xs" variant="ghost" aria-label={t('harness.pdf.zoomOut')} onClick={() => setScale((value) => value / 1.25)}>−</Button>
            <span className="min-w-10 text-center text-xs tabular-nums text-muted-foreground">{Math.round(scale * 100)}%</span>
            <Button type="button" size="xs" variant="ghost" aria-label={t('harness.pdf.zoomIn')} onClick={() => setScale((value) => value * 1.25)}>+</Button>
          </div>
          <div ref={pageViewportRef} className="min-h-0 flex-1 overflow-auto bg-[var(--surface-subtle)]/40 p-3 text-center">
            {loading && !overview ? <div role="status" className="p-8 text-sm text-muted-foreground">{t('harness.pdf.loading')}</div> : null}
            {pageLoading ? <div role="status" className="p-2 text-xs text-muted-foreground">{t('harness.pdf.loadingPage')}</div> : null}
            {pageSrc ? (
                <div
                  className="flex min-h-full min-w-full items-center justify-center"
                  style={displayPageSize ? {
                    width: `${Math.max(viewportSize.width, displayPageSize.width)}px`,
                    height: `${Math.max(viewportSize.height, displayPageSize.height)}px`,
                  } : undefined}
                >
                  <div
                  className="relative inline-block touch-none select-none"
                  onPointerDown={beginSelection}
                  onPointerMove={(event) => {
                    if (!selecting || !pageImageRef.current) return;
                    const point = pointerCoordinate(event);
                    if (!point) return;
                    const region = normalizePdfMaterialRegion(selecting, point, pageImageRef.current.getBoundingClientRect());
                    if (region) {
                      setSelectedRegion(region);
                      setSelectedRegionPage(page);
                    }
                  }}
                  onPointerUp={finishSelection}
                  onPointerCancel={() => setSelecting(null)}
                >
                  <img
                    ref={pageImageRef}
                    src={pageSrc}
                    alt={t('harness.pdf.pageAlt', { title, page })}
                    draggable={false}
                    onLoad={(event) => {
                      const { naturalWidth: width, naturalHeight: height } = event.currentTarget;
                      if (width > 0 && height > 0) setPageRaster({ page, width, height, scale });
                    }}
                    style={displayPageSize ? {
                      width: `${displayPageSize.width}px`,
                      height: `${displayPageSize.height}px`,
                      maxWidth: 'none',
                      maxHeight: 'none',
                    } : undefined}
                    className="block max-h-[calc(100dvh-18rem)] max-w-full rounded-sm bg-white shadow-md"
                  />
                  {selectedRegion && selectedRegionPage === page ? <div aria-label={t('harness.pdf.selectedRegion')} className="pointer-events-none absolute border-2 border-primary bg-primary/15" style={regionStyle(selectedRegion)} /> : null}
                </div>
              </div>
            ) : null}
            {!loading && !pageLoading && !pageSrc && !failure ? <p className="p-8 text-sm text-muted-foreground">{t('harness.pdf.pageImageUnavailable')}</p> : null}
          </div>
          {selectedRegion && selectedRegionPage === page ? (
            <div className="flex flex-wrap items-center gap-2 border-t border-border/50 px-3 py-2">
              <span className="mr-auto text-xs text-muted-foreground">{t('harness.pdf.regionSelected')}</span>
            <Button type="button" size="sm" disabled={!canRead || !currentSourceHash || loading || !currentSnapshotId} onClick={() => void askAboutSelection()}>
                {loading ? t('harness.pdf.addingToDraft') : t('harness.pdf.askAboutSelection')}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {view === 'text' ? (
        <div className="min-h-0 flex-1 overflow-auto p-4">
          <div className="mb-3 flex justify-end">
            <Button type="button" size="xs" variant="outline" disabled={!canRead || !currentSnapshotId || loading} onClick={() => void runCurrentPageOcr()}>
              {t('harness.pdf.readCurrentPageWithOcr')}
            </Button>
          </div>
          {findHits?.length ? (
            <div className="mb-4 rounded-lg border border-border/50 bg-background/50 p-2">
              <div className="mb-1 text-xs font-medium text-muted-foreground">{t('harness.pdf.searchResults', { count: findHits.length })}</div>
              <div className="space-y-1">
                {findHits.map((hit, index) => (
                  <button key={`${hit.page}:${hit.start}:${index}`} type="button" onClick={() => selectFindHit(hit)} className="block w-full rounded px-2 py-1 text-left text-xs hover:bg-interactive-hover">
                    <span className="mr-2 text-muted-foreground">{t('harness.pdf.pageNumber', { page: hit.page })}</span>{hit.snippet}
                  </button>
                ))}
              </div>
            </div>
          ) : searchText.trim() && !loading ? <p className="mb-3 text-xs text-muted-foreground">{t('harness.pdf.noSearchResults')}</p> : null}
          {loading ? <div role="status" className="text-sm text-muted-foreground">{t('harness.pdf.loading')}</div> : text ? <SimpleMarkdownRenderer content={text} className="typography-markdown-body" enableFileReferences={false} /> : <p className="text-sm text-muted-foreground">{t('harness.pdf.textUnavailable')}</p>}
        </div>
      ) : null}

      {view === 'structure' ? (
        <div className="min-h-0 flex-1 overflow-auto p-4">
          <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-border/50 bg-background/50 p-2">
            <div className="flex items-center gap-1" role="group" aria-label={t('harness.pdf.analysisRange')}>
              <Button type="button" size="xs" variant={structureScope === 'page' ? 'secondary' : 'ghost'} aria-pressed={structureScope === 'page'} onClick={() => setStructureScope('page')}>
                {t('harness.pdf.currentPage')}
              </Button>
              <Button type="button" size="xs" variant={structureScope === 'document' ? 'secondary' : 'ghost'} aria-pressed={structureScope === 'document'} onClick={() => setStructureScope('document')}>
                {t('harness.pdf.wholeDocument')}
              </Button>
            </div>
            <Button type="button" size="xs" disabled={analysisBusy || !canRead} onClick={() => void analyzeStructure()}>
              {analysisBusy ? t('harness.pdf.analyzing') : t('harness.pdf.analyzeStructure')}
            </Button>
            {hasTableCells ? (
              <Button type="button" size="xs" variant="ghost" aria-pressed={cellsView} onClick={() => setCellsView((value) => !value)}>
                {t(cellsView ? 'harness.pdf.structureView' : 'harness.pdf.cellsView')}
              </Button>
            ) : null}
            {overview?.textStatus === 'unavailable' ? <span className="text-xs text-muted-foreground">{t('harness.pdf.textUnavailable')}</span> : null}
          </div>
          {loading || analysisBusy ? <div role="status" className="text-sm text-muted-foreground">{t('harness.pdf.analyzing')}</div> : null}
          {cellsView && hasTableCells ? (
            <div className="space-y-4">
              {tablesWithCells.map((table) => {
                const cells = table.cells ?? [];
                if (cells.length > 0) {
                  const columns = Math.max(1, ...cells.map((cell) => cell.column + (cell.columnSpan ?? 1)));
                  const rowCount = Math.max(1, ...cells.map((cell) => cell.row + (cell.rowSpan ?? 1)));
                  return (
                    <div key={table.id} className="overflow-x-auto rounded border border-border/50">
                      <div role="table" aria-rowcount={rowCount} aria-colcount={columns} className="grid min-w-full text-xs" style={{ gridTemplateColumns: `repeat(${columns}, minmax(5rem, 1fr))`, gridTemplateRows: `repeat(${rowCount}, auto)` }}>
                        {cells.map((cell, cellIndex) => (
                          <div
                            key={`${cell.row}:${cell.column}:${cellIndex}`}
                            role={cell.columnHeader ? 'columnheader' : cell.rowHeader ? 'rowheader' : 'cell'}
                            className={`border border-border/40 px-2 py-1 align-top ${cell.columnHeader || cell.rowHeader || cell.rowSection ? 'bg-muted/40 font-medium' : ''}`}
                            style={{ gridColumn: `${cell.column + 1} / span ${cell.columnSpan ?? 1}`, gridRow: `${cell.row + 1} / span ${cell.rowSpan ?? 1}` }}
                          >{cell.text}</div>
                        ))}
                      </div>
                    </div>
                  );
                }
                return (
                  <div key={table.id} className="overflow-x-auto rounded border border-border/50">
                    {(table.rows ?? []).map((row, rowIndex) => (
                      <table key={rowIndex} className="min-w-full border-collapse text-xs"><tbody><tr>{row.cells.map((cell, cellIndex) => <td key={cellIndex} className="border border-border/40 px-2 py-1 align-top">{cell.text}</td>)}</tr></tbody></table>
                    ))}
                  </div>
                );
              })}
            </div>
          ) : structure ? (
            <div className="space-y-4 text-sm">
              {structure.blocks?.length ? (
                <details>
                  <summary className="cursor-pointer text-xs font-medium text-muted-foreground">{t('harness.pdf.readingOrder', { count: structure.blocks.length })}</summary>
                  <ol className="mt-2 space-y-1">
                    {structure.blocks.map((block) => (
                      <li key={block.id} className="flex gap-2">
                        <button type="button" className="shrink-0 text-xs text-muted-foreground hover:text-primary" onClick={() => navigateToPage(block.page, block.regions[0]?.region)}>
                          {t('harness.pdf.pageNumber', { page: block.page })}
                        </button>
                        <span className="min-w-0 whitespace-pre-wrap text-xs">{block.text}</span>
                      </li>
                    ))}
                  </ol>
                </details>
              ) : null}
              {structure.elements?.length ? (
                <section>
                  <h3 className="mb-2 text-xs font-medium text-muted-foreground">{t('harness.pdf.elements')}</h3>
                  <ol className="space-y-2">
                    {structure.elements.map((element) => {
                      const region = element.regions[0];
                      const caption = element.captions?.map((item) => item.text).filter(Boolean).join('\n');
                      const detail = element.text || caption || (element.kind === 'table' && element.cells?.length
                        ? t('harness.pdf.tableCells', { count: element.cells.length })
                        : '');
                      return (
                        <li key={element.id} className="flex gap-2 rounded border border-border/40 px-2 py-1.5">
                          <button type="button" className="shrink-0 text-xs text-muted-foreground hover:text-primary" onClick={() => navigateToPage(region?.page ?? element.page, region?.region)}>
                            {t('harness.pdf.pageNumber', { page: region?.page ?? element.page })}
                          </button>
                          <div className="min-w-0">
                            <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{t(`harness.pdf.element.${element.kind}`)}</div>
                            {detail ? <p className="mt-0.5 whitespace-pre-wrap text-xs">{detail}</p> : null}
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                </section>
              ) : null}
              {!structure.elements?.length && structure.headings?.length ? (
                <section>
                  <h3 className="mb-2 text-xs font-medium text-muted-foreground">{t('harness.pdf.headings')}</h3>
                  <ol className="space-y-1">{structure.headings.map((heading, index) => <li key={`${heading.line}:${index}`} style={{ paddingLeft: `${Math.max(0, heading.level - 1) * 0.75}rem` }}><button type="button" className="text-left hover:text-primary" onClick={() => navigateToPage(heading.regions?.[0]?.page ?? page, heading.regions?.[0]?.region)}>{heading.title}</button></li>)}</ol>
                </section>
              ) : null}
              {structure.pages?.length ? <section><h3 className="mb-2 text-xs font-medium text-muted-foreground">{t('harness.pdf.pages')}</h3><div className="flex flex-wrap gap-1">{structure.pages.map((entry) => <button key={entry.page} type="button" className="rounded border border-border/50 px-2 py-1 text-xs hover:bg-interactive-hover" onClick={() => navigateToPage(entry.page)}>{t('harness.pdf.pageNumber', { page: entry.page })}</button>)}</div></section> : null}
              {(structure.tables?.length || structure.elements?.some((element) => element.kind === 'table')) ? <section><h3 className="mb-2 text-xs font-medium text-muted-foreground">{t('harness.pdf.tables')}</h3><p className="text-xs text-muted-foreground">{t('harness.pdf.tablesFound', { count: structure.elements?.some((element) => element.kind === 'table') ? structure.elements.filter((element) => element.kind === 'table').length : structure.tables?.length ?? 0 })}</p></section> : null}
              {!structure.blocks?.length && !structure.elements?.length && !structure.headings?.length && !structure.pages?.length && !structure.tables?.length && !structure.layouts?.length && !structure.figures?.length && !structure.formulas?.length ? <p className="text-sm text-muted-foreground">{t('harness.pdf.noStructure')}</p> : null}
              {structure.layouts?.length ? <section><h3 className="mb-2 text-xs font-medium text-muted-foreground">{t('harness.pdf.pageLayouts')}</h3><p className="text-xs text-muted-foreground">{t('harness.pdf.layoutsFound', { count: structure.layouts.length })}</p></section> : null}
              {structure.figures?.length ? <section><h3 className="mb-2 text-xs font-medium text-muted-foreground">{t('harness.pdf.figures')}</h3><ul className="list-disc space-y-1 pl-5 text-xs">{structure.figures.map((figure, index) => <li key={figure.elementId ?? `${figure.line}:${index}`}>{figure.title || figure.captions?.map((caption) => caption.text).join(' · ') || t('harness.pdf.figureNumber', { index: index + 1 })}</li>)}</ul></section> : null}
              {structure.formulas?.length ? <section><h3 className="mb-2 text-xs font-medium text-muted-foreground">{t('harness.pdf.formulas')}</h3><ul className="space-y-1 text-xs">{structure.formulas.map((formula, index) => <li key={formula.elementId ?? `${formula.line}:${index}`} className="font-mono">{formula.text}</li>)}</ul></section> : null}
            </div>
          ) : <p className="text-sm text-muted-foreground">{t('harness.pdf.noStructure')}</p>}
        </div>
      ) : null}

      {failure ? <p role="alert" className="border-t border-[var(--status-error)]/25 bg-[var(--status-error)]/5 px-3 py-2 text-xs text-[var(--status-error)]">{failure}</p> : null}
      {notice ? <p role="status" className="border-t border-border/40 px-3 py-2 text-xs text-muted-foreground">{notice}</p> : null}
    </div>
  );

  if (!open) return null;
  if (presentation === 'inline') {
    return (
      <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-border/60 bg-background" aria-label={t('harness.pdf.readerTitle')}>
        <header className="border-b border-border/50 px-3 py-2">
          <h2 className="truncate text-sm font-medium text-foreground">{title}</h2>
          <p className="text-xs text-muted-foreground">{t('harness.pdf.readerDescription')}</p>
        </header>
        {readerContent}
      </section>
    );
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(94dvh,1040px)] max-w-[min(96vw,1320px)] flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b border-border/50 px-4 py-3 pr-12">
          <DialogTitle className="truncate text-left">{title}</DialogTitle>
          <DialogDescription>{t('harness.pdf.readerDescription')}</DialogDescription>
        </DialogHeader>
        {readerContent}
      </DialogContent>
    </Dialog>
  );
};
