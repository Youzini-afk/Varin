import React from 'react';
import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { patchEditorViewState } from '@/lib/workbench/editors/session';
import type { EditorTab } from '@/lib/workbench/editors/types';

export function MarkdownResourcePreview({ workspaceId, tab, content }: { workspaceId: string; tab: EditorTab; content: string }) {
  const viewport = React.useRef<HTMLDivElement>(null);
  const initialScroll = React.useRef(tab.viewState.previewScrollTop ?? 0);
  const pendingRestore = React.useRef(true);
  const restore = React.useCallback(() => {
    if (!pendingRestore.current || !viewport.current) return;
    viewport.current.scrollTop = initialScroll.current;
    pendingRestore.current = false;
  }, []);
  const takeControl = () => { pendingRestore.current = false; };
  return <div ref={viewport} className="h-full overflow-auto p-3" onWheel={takeControl} onPointerDown={takeControl} onKeyDown={takeControl}
    onScroll={event => patchEditorViewState(workspaceId, tab.viewId, { previewScrollTop: event.currentTarget.scrollTop })}>
    <SimpleMarkdownRenderer content={content} className="typography-markdown-body" stripFrontmatter enableFileReferences={false} onContentChange={restore} />
  </div>;
}
