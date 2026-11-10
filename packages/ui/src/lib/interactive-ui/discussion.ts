import { conversationUiText, type ConversationUiNode, type UiObservation, type UiViewState } from '@varin/application-client';

/** Explicit application context is meaningful data, not the source/lease envelope. */
function readableContext(value: unknown, prefix = ''): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap((item, index) => readableContext(item, prefix ? `${prefix} ${index + 1}` : String(index + 1)));
  if (typeof value === 'object') return Object.entries(value).flatMap(([key, item]) => readableContext(item, prefix ? `${prefix} · ${key}` : key));
  return [`${prefix ? `${prefix}: ` : ''}${String(value)}`];
}
export function uiDiscussionText(observation: UiObservation): string {
  if (observation.context !== undefined && observation.context !== null) return readableContext(observation.context).join('\n');
  // This is the frame owner's captured visible structure. It excludes scripts,
  // selectors, layout coordinates, scroll state and arbitrary business internals.
  return (observation.structure ?? []).map(node => [node.text, node.value].filter(value => value !== undefined && value !== '').join(': ')).filter(Boolean).join('\n');
}
export function declarativeDiscussionText(node: ConversationUiNode, state: UiViewState): string {
  if (node.type === 'tabs') {
    const selected = node.tabs.find(tab => tab.key === state.controls.tab) ?? node.tabs[0];
    return [node.label, selected?.label, selected?.content].filter(Boolean).join('\n\n');
  }
  return conversationUiText(node, state.data && typeof state.data === 'object' && !Array.isArray(state.data) ? state.data : {});
}
