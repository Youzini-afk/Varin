export interface OverlayThumbMetrics {
  length: number;
  offset: number;
}

export const EMPTY_OVERLAY_THUMB: OverlayThumbMetrics = { length: 0, offset: 0 };

export const calculateOverlayThumbMetrics = (options: {
  viewportLength: number;
  contentLength: number;
  scrollOffset: number;
  trackLength: number;
  minThumbSize: number;
  trackInset?: number;
}): OverlayThumbMetrics => {
  const trackInset = options.trackInset ?? 8;
  if (options.contentLength <= options.viewportLength) return EMPTY_OVERLAY_THUMB;
  const usableTrack = Math.max(options.trackLength - trackInset * 2, 0);
  const rawThumb = (options.viewportLength / options.contentLength) * usableTrack;
  const length = Math.min(usableTrack, Math.max(options.minThumbSize, rawThumb));
  const maxOffset = Math.max(usableTrack - length, 0);
  const maxScroll = Math.max(options.contentLength - options.viewportLength, 1);
  const offset = Math.max(0, Math.min(1, options.scrollOffset / maxScroll)) * maxOffset;
  return { length, offset };
};
