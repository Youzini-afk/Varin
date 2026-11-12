import React from 'react';
import type { ConversationOrganizationCommand } from '@varin/application-client';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { unresolvedOrganizationMetadata, type OrganizationMetadataIntent } from '@/stores/useConversationOrganizationStore';
import { organizationObjectKey } from './organizationProjection';

export function OrganizationOperationFeedback({ failed, pendingKeys, intents, onCheck, onRetry, name }: {
  failed: ConversationOrganizationCommand[]; intents: OrganizationMetadataIntent[];
  pendingKeys: ReadonlySet<string>;
  onCheck(command: ConversationOrganizationCommand): void; onRetry(key: string): void;
  name(reference: { kind: string; id: string }): string;
}) {
  const { t } = useI18n();
  const labels = { succeeded: t('organization.resultSucceeded'), conflict: t('organization.resultConflict'), busy: t('organization.resultBusy'), failed: t('organization.resultFailed'), unknown: t('organization.resultUnknown') };
  return <>
    {failed.map(command => <div key={command.key} role="status" className="flex items-center gap-2 px-3 py-2 typography-meta text-muted-foreground"><Icon name="information" className="size-3.5 shrink-0" /><span className="min-w-0">{'name' in command.operation && command.operation.name && <span className="mb-0.5 block truncate text-foreground">{command.operation.name}</span>}{t('organization.unknown')}</span><button type="button" disabled={pendingKeys.has(command.key)} className="ml-auto shrink-0 underline underline-offset-2 disabled:opacity-50" onClick={() => onCheck(command)}>{t('organization.checkReceipt')}</button></div>)}
    {intents.filter(intent => unresolvedOrganizationMetadata(intent).length).map(intent => <Collapsible key={intent.input.key} className="mx-2 my-1 rounded-lg bg-interactive-hover/50" role="status">
      <CollapsibleTrigger className="gap-2 typography-meta text-muted-foreground"><Icon name="information" className="size-3.5 shrink-0" /><span className="min-w-0 flex-1 text-left">{t('organization.partial')}</span><Icon name="arrow-down-s" className="size-3" /></CollapsibleTrigger>
      <CollapsibleContent><div className="space-y-2 px-2 pb-2">
        {intent.results.map(result => <div key={organizationObjectKey(result.conversation)} className="typography-meta"><div className="flex gap-2"><span className="min-w-0 flex-1 truncate">{intent.names?.[organizationObjectKey(result.conversation)] || name(result.conversation)}</span><span className="shrink-0 text-muted-foreground">{labels[result.status]}</span></div>{result.message && result.status !== 'succeeded' && <p className="mt-1 break-words typography-micro text-muted-foreground">{result.message}</p>}</div>)}
        {!intent.results.length && <p className="typography-meta text-muted-foreground">{t('organization.unknown')}</p>}
        <Button type="button" variant="ghost" size="sm" disabled={intent.pending} onClick={() => onRetry(intent.input.key)}>{intent.pending && <Icon name="loader-4" className="mr-1 size-3 animate-spin" />}{t('organization.retryUnconfirmed')}</Button>
      </div></CollapsibleContent>
    </Collapsible>)}
  </>;
}
