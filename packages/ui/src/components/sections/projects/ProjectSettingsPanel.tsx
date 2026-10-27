import React from 'react';
import { SettingsTabs } from '../shared/SettingsTabs';
import { useSettingsSearchTarget } from '@/lib/settings/search-target';
import { useI18n } from '@/lib/i18n';
import { WorktreeSectionContent } from '@/components/sections/varin/WorktreeSectionContent';
import { ProjectActionsSection } from '@/components/sections/projects/ProjectActionsSection';
import { ProjectIdentityFields } from '@/components/sections/projects/ProjectIdentityFields';
import {
  useProjectIdentityForm,
  type ProjectIdentitySaveData,
} from '@/components/sections/projects/useProjectIdentityForm';
import { useProjectIdentityAutoSave } from '@/components/sections/projects/useProjectIdentityAutoSave';
import type { ProjectEntry } from '@varin/application-client';
import { ProjectFoldersSettings } from './ProjectFoldersEditor';
import {ProjectWorkspaceSection} from './ProjectWorkspaceSection';

type ProjectSettingsPanelProps = {
  project: ProjectEntry | null;
  onIdentitySave: (data: ProjectIdentitySaveData) => void | Promise<void>;
  /**
   * The project-edit dialog hides the worktree section — worktrees have
   * their own full-page surface (project menu → Manage worktrees). Settings
   * keeps the full panel.
   */
  showWorktrees?: boolean;
};

export const ProjectSettingsPanel: React.FC<ProjectSettingsPanelProps> = ({
  project,
  onIdentitySave,
  showWorktrees = true,
}) => {
  const form = useProjectIdentityForm(project);
  const { t } = useI18n();
  const [tab, setTab] = React.useState<'identity' | 'folders' | 'actions' | 'worktrees'>('identity');
  const target = useSettingsSearchTarget();
  React.useEffect(() => {
    if (!target?.startsWith('projects.')) return;
    setTab(target.startsWith('projects.worktree') ? 'worktrees' : target === 'projects.actions' ? 'actions' : target.includes('folder') ? 'folders' : 'identity');
  }, [target]);

  const projectRef = React.useMemo(() => {
    if (!project) {
      return null;
    }
    return { id: project.id, path: project.path };
  }, [project]);

  const handleIdentitySave = React.useCallback(async (data: ProjectIdentitySaveData) => {
    await onIdentitySave(data);
  }, [onIdentitySave]);

  useProjectIdentityAutoSave(form, handleIdentitySave);

  if (!project || !projectRef) {
    return null;
  }

  return (
    <div className="space-y-0">
      {showWorktrees ? <SettingsTabs value={tab} onChange={setTab} label={t('settings.page.projects.title')} items={[
        { value: 'identity', label: t('settings.experience.projectIdentity') },
        { value: 'folders', label: t('settings.experience.projectFolders') },
        { value: 'actions', label: t('settings.experience.projectActions') },
        { value: 'worktrees', label: t('settings.experience.projectWorktrees') },
      ]} /> : null}
      <div className="settings-tab-panel" hidden={showWorktrees && tab !== 'identity'}><ProjectIdentityFields form={form} /></div>
      <div className="settings-tab-panel" hidden={showWorktrees && tab !== 'folders'}><ProjectFoldersSettings project={project} /><ProjectWorkspaceSection project={project}/></div>
      <div className="settings-tab-panel" hidden={showWorktrees && tab !== 'actions'}><ProjectActionsSection projectRef={projectRef} /></div>
      {showWorktrees ? <div className="settings-tab-panel" hidden={tab !== 'worktrees'}><WorktreeSectionContent projectRef={projectRef} /></div> : null}
    </div>
  );
};
