import type { ComposerEditorHandle } from './ComposerEditor';
const editors = new Map<string, ComposerEditorHandle>();
/** Keys include Host and original conversation identity. Never resolve an active-tab fallback. */
export const findMarkerComposer = (key: string): ComposerEditorHandle | undefined => editors.get(key);
export function registerMarkerComposer(key: string, editor: ComposerEditorHandle): () => void {
  editors.set(key, editor);
  return () => { if (editors.get(key) === editor) editors.delete(key); };
}
