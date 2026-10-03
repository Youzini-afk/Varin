import { describe, expect, test } from 'vitest';
import {
  buildPdfMaterialCitationMarkdown,
  formatPdfMaterialCitationUrl,
  normalizePdfMaterialRegion,
  parsePdfMaterialCitationUrl,
  pdfMaterialMarkdownHref,
  pdfMaterialUrlFromMarkdownHref,
} from './pdfMaterialCitation';

describe('PDF material citations', () => {
  test('normalizes a dragged selection to rotated-page coordinates', () => {
    expect(normalizePdfMaterialRegion(
      { x: 160, y: 120 },
      { x: 40, y: 30 },
      { left: 10, top: 10, width: 200, height: 200 },
    )).toEqual({ x: 0.15, y: 0.1, width: 0.6, height: 0.45 });
  });

  test('keeps the current snapshot, source hash, page, and normalized region in the URI', () => {
    const citation = {
      snapshotId: 'snapshot-42',
      page: 8,
      sourceHash: 'sha256:original-hash',
      analysisId: 'analysis-3',
      region: { x: 0.12, y: 0.23, width: 0.34, height: 0.45 },
    };
    const url = formatPdfMaterialCitationUrl(citation);
    expect(url).toContain('varin-material://snapshot-42?');
    expect(parsePdfMaterialCitationUrl(url)).toEqual(citation);
  });

  test('stores a human-readable draft label and hides the hash in the visible text', () => {
    const markdown = buildPdfMaterialCitationMarkdown('A [paper]', {
      snapshotId: 'snapshot-42',
      sourceHash: 'sha256:secret-long-hash',
      page: 8,
      region: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
    });
    expect(markdown).toContain('[A \\[paper\\], p. 8 selection]');
    const visibleLabel = markdown.slice(0, markdown.indexOf(']('));
    expect(visibleLabel).not.toContain('secret-long-hash');
    const href = markdown.slice(markdown.indexOf('](') + 2, -1);
    expect(parsePdfMaterialCitationUrl(href)?.sourceHash).toBe('sha256:secret-long-hash');
  });

  test('uses a safe in-app anchor while preserving the original citation URL', () => {
    const href = 'varin-material://snapshot-42?page=2';
    expect(pdfMaterialUrlFromMarkdownHref(pdfMaterialMarkdownHref(href))).toBe(href);
    expect(pdfMaterialUrlFromMarkdownHref('#ordinary-link')).toBeNull();
  });

  test('rejects partial or out-of-bounds selections', () => {
    expect(parsePdfMaterialCitationUrl('varin-material://snapshot-42?page=2&x=0.1')).toBeNull();
    expect(parsePdfMaterialCitationUrl('varin-material://snapshot-42?page=2&x=0.8&y=0.2&width=0.3&height=0.2')).toBeNull();
  });
});
