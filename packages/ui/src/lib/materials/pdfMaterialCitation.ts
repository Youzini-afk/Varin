import type { WebDocumentRegion } from '@varin/protocol';

export const PDF_MATERIAL_OPEN_EVENT = 'varin:open-pdf-material';

export interface PdfMaterialCitation {
  snapshotId: string;
  page: number;
  sourceHash?: string;
  analysisId?: string;
  region?: WebDocumentRegion;
}

const validRegion = (value: Partial<WebDocumentRegion>): value is WebDocumentRegion => (
  Number.isFinite(value.x)
  && Number.isFinite(value.y)
  && Number.isFinite(value.width)
  && Number.isFinite(value.height)
  && (value.x ?? -1) >= 0
  && (value.y ?? -1) >= 0
  && (value.width ?? 0) > 0
  && (value.height ?? 0) > 0
  && (value.x ?? 0) + (value.width ?? 0) <= 1.000001
  && (value.y ?? 0) + (value.height ?? 0) <= 1.000001
);

export const normalizePdfMaterialRegion = (
  start: { x: number; y: number },
  end: { x: number; y: number },
  bounds: { left: number; top: number; width: number; height: number },
): WebDocumentRegion | null => {
  if (!(bounds.width > 0) || !(bounds.height > 0)) return null;
  const left = Math.min(start.x, end.x);
  const top = Math.min(start.y, end.y);
  const right = Math.max(start.x, end.x);
  const bottom = Math.max(start.y, end.y);
  const clamp = (value: number) => Math.max(0, Math.min(1, value));
  const x = clamp((left - bounds.left) / bounds.width);
  const y = clamp((top - bounds.top) / bounds.height);
  const x2 = clamp((right - bounds.left) / bounds.width);
  const y2 = clamp((bottom - bounds.top) / bounds.height);
  const region = {
    x: Number(x.toFixed(6)),
    y: Number(y.toFixed(6)),
    width: Number((x2 - x).toFixed(6)),
    height: Number((y2 - y).toFixed(6)),
  };
  return validRegion(region) ? region : null;
};

export const formatPdfMaterialCitationUrl = (citation: PdfMaterialCitation): string => {
  const query = new URLSearchParams({ page: String(Math.max(1, Math.trunc(citation.page))) });
  if (citation.sourceHash) query.set('sourceHash', citation.sourceHash);
  if (citation.analysisId) query.set('analysisId', citation.analysisId);
  if (citation.region && validRegion(citation.region)) {
    query.set('x', String(citation.region.x));
    query.set('y', String(citation.region.y));
    query.set('width', String(citation.region.width));
    query.set('height', String(citation.region.height));
  }
  return `varin-material://${encodeURIComponent(citation.snapshotId)}?${query.toString()}`;
};

export const parsePdfMaterialCitationUrl = (value: string): PdfMaterialCitation | null => {
  if (!value.startsWith('varin-material://')) return null;
  const raw = value.slice('varin-material://'.length);
  const queryStart = raw.indexOf('?');
  const rawId = queryStart < 0 ? raw : raw.slice(0, queryStart);
  let snapshotId: string;
  try {
    snapshotId = decodeURIComponent(rawId);
  } catch {
    return null;
  }
  if (!snapshotId || snapshotId.includes('/') || snapshotId.includes('#')) return null;
  const params = new URLSearchParams(queryStart < 0 ? '' : raw.slice(queryStart + 1));
  const page = Number(params.get('page'));
  if (!Number.isSafeInteger(page) || page < 1) return null;

  const coords = ['x', 'y', 'width', 'height'].map((key) => {
    const rawValue = params.get(key);
    return rawValue === null ? Number.NaN : Number(rawValue);
  });
  let region: WebDocumentRegion | undefined;
  if (coords.some(Number.isFinite)) {
    const candidate = { x: coords[0]!, y: coords[1]!, width: coords[2]!, height: coords[3]! };
    if (!validRegion(candidate)) return null;
    region = candidate;
  }

  return {
    snapshotId,
    page,
    ...(params.get('sourceHash') ? { sourceHash: params.get('sourceHash')! } : {}),
    ...(params.get('analysisId') ? { analysisId: params.get('analysisId')! } : {}),
    ...(region ? { region } : {}),
  };
};

export const pdfMaterialMarkdownHref = (value: string): string => (
  `#varin-material:${encodeURIComponent(value)}`
);

export const pdfMaterialUrlFromMarkdownHref = (value: string): string | null => {
  if (!value.startsWith('#varin-material:')) return null;
  try {
    return decodeURIComponent(value.slice('#varin-material:'.length));
  } catch {
    return null;
  }
};

export const buildPdfMaterialCitationMarkdown = (
  title: string,
  citation: PdfMaterialCitation,
): string => {
  const pageLabel = `p. ${Math.max(1, Math.trunc(citation.page))}`;
  const regionLabel = citation.region ? ' selection' : '';
  const label = `${title.replace(/[\\[\]]/g, '\\$&')}, ${pageLabel}${regionLabel}`;
  return `[${label}](${formatPdfMaterialCitationUrl(citation)})`;
};
