import React from 'react';
import type { ConversationOrganizationRef } from '@varin/application-client';
import { useConversationOrganizationEntry } from '@/hooks/useConversationOrganizationEntry';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useI18n } from '@/lib/i18n';
import { ConversationOrigin } from './ConversationOrigin';
import { refreshConversationOrganization } from '@/stores/useConversationOrganizationStore';

/** Shared detail metadata, separate from the execution workspace displayed by each owner. */
export function ConversationOrganizationDetails({ reference, active }: { reference: ConversationOrganizationRef; active: boolean }) {
  const { t } = useI18n();
  const organization = useConversationOrganizationEntry(reference, active, true);
  const projects = useProjectsStore(state => state.projects);
  if (!organization.available) return null;
  const location = organization.path?.map(container => container.kind === 'project'
    ? projects.find(project => project.id === container.projectId)?.label || projects.find(project => project.id === container.projectId)?.path || t('organization.missingProject', { id: container.projectId ?? '' })
    : container.name).join(' / ');
  const origin = organization.entry?.origin;
  return <div className="my-3 space-y-1 typography-meta">
    {organization.error ? <p role="alert" className="text-destructive">{organization.error}</p> : <>
      <p className="min-w-0 break-words"><span className="text-muted-foreground">{t('organization.location')}: </span>{organization.path ? location || t('organization.root') : t(organization.pathError || organization.pathUnavailable ? 'organization.locationUnavailable' : 'common.loading')}</p>
      {(organization.pathError || organization.pathUnavailable) && <p role="alert" className="text-destructive">{organization.pathError ?? t('organization.locationUnavailable')} <button type="button" className="underline" onClick={() => void refreshConversationOrganization()}>{t('common.retry')}</button></p>}
      {origin?.botId && origin.botId !== origin.directBotId && <div className="flex items-center gap-2"><span className="text-muted-foreground">{t('organization.origin')}</span><ConversationOrigin origin={origin} /></div>}
    </>}
  </div>;
}
