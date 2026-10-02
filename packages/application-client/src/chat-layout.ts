/** Maximum chat column width in CSS pixels. Zero fills the available pane. */
export const DEFAULT_CHAT_CONTENT_WIDTH = 960;

export const isChatContentWidth = (value: unknown): value is number => (
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
);
