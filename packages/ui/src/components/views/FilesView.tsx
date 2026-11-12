import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { SidebarFilesTree } from '@/components/layout/SidebarFilesTree';
import { EditorWorkbenchArea } from '@/components/workbench/EditorWorkbenchArea';
import { useDeviceInfo } from '@/lib/device';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { getRuntimeKey, freezeProjectSourceSelection } from '@varin/application-client';
import { ResourceFilesView } from './ResourceFilesView';
import { useI18n } from '@/lib/i18n';

/**
 * The Files surface is now a composition over the shared Explorer and Editor
 * Workbench kernels. It deliberately owns no document buffer or second tab
 * model, so Agent Workspace, IDE Workspace, and extension-owned shells all see
 * the same open editors.
 */
const LocalFilesView: React.FC = () => {
  const { t } = useI18n();
  const { isMobile } = useDeviceInfo();
  const [mobileEditorVisible, setMobileEditorVisible] = React.useState(false);

  if (isMobile) {
    if (mobileEditorVisible) {
      return (
        <div className="flex h-full min-h-0 flex-col bg-background">
          <div className="flex shrink-0 items-center border-b border-border/60 px-2 py-1">
            <Button type="button" variant="ghost" size="sm" onClick={() => setMobileEditorVisible(false)}>
              <Icon name="arrow-left" className="size-4" />
              {t('filesView.editor.back')}
            </Button>
          </div>
          <div className="min-h-0 flex-1"><EditorWorkbenchArea /></div>
        </div>
      );
    }
    return (
      <SidebarFilesTree
        openTarget="editor"
        onEditorOpen={() => setMobileEditorVisible(true)}
      />
    );
  }

  return (
    <div className="@container flex h-full min-h-0 min-w-0 overflow-hidden bg-background">
      <aside className="min-h-0 min-w-64 basis-[30%] border-r border-border/60">
        <SidebarFilesTree openTarget="editor" />
      </aside>
      <main className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <EditorWorkbenchArea />
      </main>
    </div>
  );
};


/** Remote projects retain their actual resource/document owner in every file operation. */
export const FilesView: React.FC = () => {
  const project = useProjectsStore(state => state.projects.find(project => project.id === state.activeProjectId));
  if (project?.source?.resourceOwner.kind === 'managed_host') return <ResourceFilesView
    key={`${getRuntimeKey()}:${project.id}:${JSON.stringify([project.path,project.source,project.versionedWorkspace])}`}
    view={{ kind: 'files', key: project.id, owner: project.source.resourceOwner, title: project.label ?? project.path, path: project.path, selection: freezeProjectSourceSelection(project) }}
    active />;
  return <LocalFilesView />;
};
