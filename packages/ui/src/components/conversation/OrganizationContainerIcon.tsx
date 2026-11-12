import type { ConversationOrganizationContainer, ProjectEntry } from '@varin/application-client';
import { Icon } from '@/components/icon/Icon';
import { ProjectIconImage, PROJECT_ICON_MAP, PROJECT_COLOR_MAP } from '@/lib/projectMeta';

import { organizationIcon } from './organizationAppearance';

export function OrganizationContainerIcon({ container, project }: { container: Pick<ConversationOrganizationContainer, 'kind' | 'icon' | 'color'>; project?: ProjectEntry }) {
  if (container.kind === 'group') return <Icon name={organizationIcon(container.icon)} className="size-3.5 shrink-0" style={{ color: container.color || undefined }} />;
  const fallback = <Icon name={project?.icon && PROJECT_ICON_MAP[project.icon] || 'folder-open'} className="size-3.5 shrink-0" style={{ color: project?.color ? PROJECT_COLOR_MAP[project.color] : undefined }} />;
  return project ? <span className="size-4 shrink-0 overflow-hidden rounded-sm" style={{ backgroundColor: project.iconBackground || undefined }}><ProjectIconImage project={project} className="size-4 object-contain" fallback={fallback} /></span> : fallback;
}
