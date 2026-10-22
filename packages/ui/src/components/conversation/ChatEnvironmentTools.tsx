import React from 'react';
import { getRuntimeApiBaseUrl } from '@varin/application-client';
import { isLoopbackHttpUrl } from '@/lib/url';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { requestSettingsNavigation } from '@/lib/settings/drafts';
import { JsonSummaryView } from '@/components/chat/message/parts/JsonSummaryView';
import { ToolDisclosure, ToolStatus } from './ToolDisclosure';
import { ToolResultNotice } from './ChatResourceTools';
import { SourceLink } from './ChatSourceTools';
import { invocationOperationId, toolRecord, toolText } from './toolInvocation';
import { useToolOperation } from './useToolOperation';
import { toolValueLabel } from './toolLabels';
import type { ToolViewProps } from './toolViewTypes';
import { useOptionalConversationPresentation } from './ConversationContext';
import { useToolAction } from './useToolAction';
import { useVarinExtensionCatalog, selectVarinExtensionCandidate, reviewVarinExtensionCandidateCapabilities } from '@/lib/extensions/catalog-store';

const records = (value: unknown) => Array.isArray(value) ? value.map(toolRecord) : [];
const endpoint = (value: Record<string, unknown>) => typeof value.port === 'number' ? `${toolText(value.host)}:${value.port}` : toolText(value.host);

function ForwardConnection({ data, operationId, projected }: { data: Record<string, unknown>; operationId?: string; projected?: ToolViewProps['execution'] }) {
  const { t } = useI18n();
  const control = useToolOperation(operationId, projected?.operation);
  const operation = control.operation;
  const access = toolRecord(data.access), service = toolRecord(access.service), local = toolRecord(access.access);
  const stopped = operation?.external_receipt?.executor_stopped === true || data.executorStopped === true;
  const listener = stopped ? 'stopped' : control.cancelRequested ? 'stopping' : toolText(data.listenerState) || 'unknown';
  const canClose = local.kind === 'forward' && !stopped && listener !== 'stopped' && !control.cancelRequested;
  // A remote Host's loopback listener is not the browser computer's loopback.
  const sameMachine = isLoopbackHttpUrl(getRuntimeApiBaseUrl() || (typeof window === 'undefined' ? '' : window.location.href));
  const openable = !isLoopbackHttpUrl(toolText(local.url)) || sameMachine;
  return <div className="tool-forward-connection">
    <div className="tool-connection-route"><div><p>{t('chat.tools.serviceLocation')}</p><strong>{toolText(service.machineId)}</strong><code>{endpoint(service)}</code></div>
      <Icon name="arrow-right" className="size-4 text-muted-foreground" />
      <div><p>{t('chat.tools.accessLocation')}</p>{openable && !['stopped','stopping','unknown','absent'].includes(listener) ? <SourceLink url={toolText(local.url)}>{endpoint(local) || toolText(local.url)}</SourceLink> : <code>{endpoint(local) || toolText(local.url)}</code>}
        <span className="typography-micro text-muted-foreground">{toolText(local.machineId)}</span></div></div>
    <div className="tool-inline-actions"><span className="typography-micro" role="status">{toolValueLabel(listener, t)}</span>
      {control.available && <button type="button" disabled={control.busy} onClick={() => void control.refresh()}><Icon name="refresh" className={control.busy ? 'size-3 animate-spin motion-reduce:animate-none' : 'size-3'} />{t('chat.tools.refresh')}</button>}
      {control.available && !control.readOnly && canClose && <button type="button" disabled={control.busy} onClick={() => void control.cancel()}>{t('chat.tools.closeForward')}</button>}</div>
    <p className="typography-micro text-muted-foreground">{t(stopped ? 'chat.tools.forwardClosed' : 'chat.tools.forwardReachability')}</p>
    {control.error && <p role="alert" className="typography-meta text-destructive">{control.error}</p>}
    <ToolResultNotice data={data} status="success" />
  </div>;
}

export function ChatForwardTool({ call, execution, result, status, generating, output, details }: ToolViewProps) {
  const { t } = useI18n();
  const data = toolRecord(result?.details ?? execution?.result), args = toolRecord(call.arguments);
  const jobs = Array.isArray(data.jobs) ? records(data.jobs) : data.access ? [data] : [];
  return <section className="tool-forward-activity">
    <div className="tool-source-heading"><Icon name="share-forward" className="size-3.5" /><span className="flex-1 typography-meta">{t('chat.tools.serviceForward')}</span><ToolStatus status={status} generating={generating} /></div>
    {jobs.map((job, index) => <ForwardConnection key={toolText(job.operationId) || index} data={job}
      operationId={toolText(job.operationId) || toolText(args.operationId) || (call.name === 'environment_forward' ? invocationOperationId(call, execution) : undefined)} projected={execution} />)}
    {Array.isArray(data.jobs) && !jobs.length && <p className="typography-meta text-muted-foreground">{t('chat.tools.noResults')}</p>}
    {!jobs.length && <ToolResultNotice data={data} status={status} />}{output}{details}
  </section>;
}

function ExtensionCandidate({ extensionId, integrity }: { extensionId: string; integrity: string }) {
  const { t } = useI18n(), conversation = useOptionalConversationPresentation(), catalog = useVarinExtensionCatalog();
  const action = useToolAction(extensionId + ':' + integrity);
  const entry = catalog.snapshot?.catalog.extensions.find(entry => entry.manifest.id === extensionId);
  const candidate = entry?.candidate?.integrity === integrity ? entry.candidate : undefined;
  const disabled = action.busy || catalog.busyExtensionId !== null || !conversation || conversation.readOnly;
  return <div className="tool-candidate-review">
    {catalog.loading && !entry && <p role="status">{t('common.loading')}</p>}
    {candidate ? <><p className="tool-package-versions"><span>{entry?.selectedVersion}</span><Icon name="arrow-right" className="size-3.5" /><strong>{candidate.resolvedVersion}</strong></p>
      {candidate.capabilityDelta.added.map((reference, index) => <div key={index} className="tool-candidate-capability"><code>{Object.values(reference).join(' · ')}</code><div className="tool-inline-actions">{[false, true].map(granted => <button key={String(granted)} type="button" disabled={disabled} onClick={() => void action.run(() => reviewVarinExtensionCandidateCapabilities({ extensionId, candidateIntegrity: integrity, decisions: [{ ...reference, granted }] }), () => {})}>{t(granted ? 'settings.varin.extensions.candidate.allow' : 'settings.varin.extensions.candidate.deny')}</button>)}</div></div>)}
      {candidate.capabilitiesReviewed && <p className="typography-micro text-muted-foreground">{t('settings.varin.extensions.candidate.reviewed')}</p>}
      <div className="tool-inline-actions"><button type="button" disabled={disabled || !candidate.capabilitiesReviewed || candidate.applyRequested} onClick={() => void action.run(() => selectVarinExtensionCandidate(extensionId, integrity), () => {})}>{t(candidate.applyRequested ? 'chat.tools.state.applicationRequested' : 'settings.varin.extensions.candidate.apply')}</button></div>
    </> : entry && <p role="status" className="typography-meta">{t(entry.integrity === integrity ? 'chat.tools.state.selected' : 'chat.tools.state.stale')}</p>}
    {(catalog.error || action.error) && <p role="alert" className="typography-meta text-destructive">{action.error || catalog.error}</p>}
  </div>;
}

export function ChatExtensionTool({ call, execution, result, status, generating, output, details }: ToolViewProps) {
  const { t } = useI18n();
  const [review, setReview] = React.useState(false);
  const data = toolRecord(result?.details ?? execution?.result), args = toolRecord(call.arguments);
  const contract = call.name === 'runtime_contract', member = toolRecord(data.member), schema = toolRecord(member.contract), page = toolRecord(data.page);
  const entries = Array.isArray(data.entries) ? records(data.entries) : data.service ? [toolRecord(data.service)] : data.slot ? [toolRecord(data.slot)] : [];
  return <section className={contract ? 'tool-contract-inspection' : 'tool-package-handoff'}>
    <div className="tool-source-heading"><Icon name={contract ? 'code-sslash' : 'box-3'} className="size-3.5" /><span className="flex-1 typography-meta">{contract ? t('chat.tools.runtimeContract') : toolText(data.extensionId) || toolText(args.extensionId) || t('chat.tools.extensionPackage')}</span><ToolStatus status={status} generating={generating} /></div>
    {!contract && <><p className="typography-meta" role="status">{data.outcome ? toolValueLabel(data.outcome, t) : toolText(args.packagePath)}</p>
      {data.resumesOnRestart === true && <p className="typography-micro text-muted-foreground">{t('chat.tools.applicationRetained')}</p>}
      {typeof data.artifactIntegrity === 'string' && <ToolDisclosure id={'package-version:' + call.id} className="tool-document-text"><summary className="typography-micro text-muted-foreground">{t('chat.tools.packageVersion')}</summary><code className="tool-identity">{data.artifactIntegrity}</code></ToolDisclosure>}
      {typeof data.extensionId === 'string' && typeof data.artifactIntegrity === 'string' && <><div className="tool-inline-actions"><button type="button" aria-expanded={review} onClick={() => setReview(!review)}>{t('chat.tools.reviewCandidate')}</button></div>{review && <ExtensionCandidate extensionId={data.extensionId} integrity={data.artifactIntegrity} />}</>}
      <div className="tool-inline-actions"><button type="button" onClick={() => requestSettingsNavigation(() => { useUIStore.getState().setSettingsPage('extensions'); useUIStore.getState().setSettingsDialogOpen(true); })}>{t('chat.tools.reviewExtension')}<Icon name="external-link" className="size-3" /></button></div></>}
    {entries.map((entry, index) => <div key={toolText(entry.serviceId ?? entry.id) || index} className="tool-contract-entry"><div className="flex flex-wrap gap-2 typography-meta"><code>{toolText(entry.serviceId) || toolText(entry.id)}</code><span className="text-muted-foreground">v{String(entry.version ?? '')} · {toolValueLabel(toolRecord(entry.selection).status ?? entry.hosting, t)}</span></div>
      {records(entry.implementations).map((provider, i) => <div key={i} className="tool-contract-provider"><span className="typography-micro text-muted-foreground">{toolText(provider.extensionId)} · {toolText(provider.extensionVersion)}</span>
        {Array.isArray(provider.methods) && <div className="tool-contract-methods">{provider.methods.filter(method => typeof method === 'string').map((method, j) => <code key={j}>{String(method)}()</code>)}</div>}</div>)}
    </div>)}
    {typeof member.name === 'string' && <div className="tool-contract-member"><code>{member.name}{member.kind === 'method' ? '()' : ''}</code>{typeof schema.description === 'string' && <p className="typography-meta whitespace-pre-wrap">{schema.description}</p>}
      <ToolDisclosure id={'contract-schema:' + call.id} className="tool-document-text"><summary className="typography-micro">{t('chat.tools.contractSchema')}</summary><JsonSummaryView data={schema} /></ToolDisclosure></div>}
    {typeof page.text === 'string' && <div className="tool-contract-source"><p className="typography-micro text-muted-foreground">{toolText(args.path)}</p><pre>{page.text}</pre>{page.nextOffset != null && <p className="typography-micro text-muted-foreground">{t('chat.tools.partialResult')}</p>}</div>}
    {data.status && data.status !== 'found' ? <p className="typography-micro text-muted-foreground">{toolValueLabel(data.status, t)}</p> : null}
    <ToolResultNotice data={data} status={status} />{output}{details}
  </section>;
}
