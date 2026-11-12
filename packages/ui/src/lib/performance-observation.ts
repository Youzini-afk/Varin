/** Opt-in counters for development and behavioral tests, never populated with user data. */
export type UiWorkCounter = 'projection.refresh' | 'catalog.list' | 'catalog.inspectMany' | 'organization.refresh' | 'conversation.render' | 'timeline.render' | 'timeline.row.render' | 'stream.publish';
export function countUiWork(name: UiWorkCounter) {
  const counts = (globalThis as { __VARIN_UI_PERFORMANCE__?: Partial<Record<UiWorkCounter, number>> }).__VARIN_UI_PERFORMANCE__;
  if (counts) counts[name] = (counts[name] ?? 0) + 1;
}
