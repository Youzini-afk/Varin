import React from 'react';
import type { ComputerArtifact } from '@varin/protocol';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { downloadComputerArtifact } from '@/lib/computers';
import { useOptionalConversationPresentation } from './ConversationContext';
import { ToolDisclosure, ToolStatus } from './ToolDisclosure';
import { ToolResultNotice } from './ChatResourceTools';
import { SourceLink } from './ChatSourceTools';
import { toolRecord, toolText } from './toolInvocation';
import { toolValueLabel } from './toolLabels';
import { useToolAction } from './useToolAction';
import { JsonSummaryView } from '@/components/chat/message/parts/JsonSummaryView';
import type { ToolViewProps } from './toolViewTypes';
import { ToolHeadingText } from './ToolHeadingText';
import { toolSubject } from './toolSubject';
import { computerProperties, computerResultSummary } from './computerToolPresentation';

const list = (value: unknown) => Array.isArray(value) ? value.map(toolRecord) : [];
const cellText = (value: unknown) => value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
const columnName = (index: number): string => { let text = ''; for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) text = String.fromCharCode(65 + (value - 1) % 26) + text; return text; };

export function OfficeGrid({ values, before, range }: { values: unknown[][]; before?: unknown[][]; range: string }) {
  const { t } = useI18n();
  const [original, setOriginal] = React.useState(false), [selection, setSelection] = React.useState<[number, number]>([0, 0]);
  const match = /^\$?([A-Z]+)\$?(\d+)/i.exec(range);
  const column = match ? [...match[1]!.toUpperCase()].reduce((n, char) => n * 26 + char.charCodeAt(0) - 64, 0) - 1 : 0;
  const row = match ? Number(match[2]) : 1, rows = original && before ? before : values;
  const columns = rows.reduce((max, cells) => Math.max(max, cells.length), 0);
  const address = columnName(column + selection[1]) + (row + selection[0]);
  return <div className="tool-office-grid">
    <div className="tool-sheet-formula"><code>{address}</code><span aria-hidden="true">ƒx</span><span>{cellText(rows[selection[0]]?.[selection[1]])}</span>{before && <button type="button" aria-pressed={original} onClick={() => setOriginal(!original)}>{t(original ? 'chat.tools.afterChanges' : 'chat.tools.beforeChanges')}</button>}</div>
    <div className="tool-sheet-scroll" data-conversation-tool-scroll="true"><table aria-label={range || t('chat.tools.office')}><thead><tr><th aria-label={t('chat.tools.row')} />{Array.from({ length: columns }, (_, i) => <th key={i} scope="col">{columnName(column + i)}</th>)}</tr></thead>
      <tbody>{rows.map((cells, r) => <tr key={r}><th scope="row">{row + r}</th>{cells.map((value, c) => <td key={c} data-changed={!original && Boolean(before) && cellText(before?.[r]?.[c]) !== cellText(value)} data-selected={selection[0] === r && selection[1] === c}><button type="button" aria-label={columnName(column + c) + (row + r) + ': ' + cellText(value)} onClick={() => setSelection([r, c])}>{cellText(value) || '\u00a0'}</button></td>)}</tr>)}</tbody></table></div>
  </div>;
}

function ComputerElements({ elements }: { elements: Record<string, unknown>[] }) {
  const { t } = useI18n();
  const byIndex = new Map(elements.map(element => [element.index, element]));
  return <ul className="space-y-2" aria-label={t('chat.tools.observedContent')}>{elements.map((element, index) => {
    const parents = new Set<unknown>([element.index]);
    let parent = byIndex.get(element.parentIndex), depth = 0;
    while (parent && !parents.has(parent.index)) { parents.add(parent.index); depth += 1; parent = byIndex.get(parent.parentIndex); }
    const state = Object.fromEntries(['value', 'enabled', 'selected', 'checked', 'expanded', 'actions']
      .filter(key => element[key] !== undefined).map(key => [key, element[key]]));
    const properties = computerProperties(state, element.unavailableProperties, undefined, t);
    return <li key={typeof element.index === 'number' ? element.index : index} className="min-w-0 whitespace-pre-wrap break-words typography-meta"
      style={depth ? { paddingInlineStart: `${depth}rem` } : undefined} data-computer-element={element.index}>
      <span className="text-muted-foreground">{typeof element.index === 'number' ? `#${element.index} · ` : ''}</span>
      <span>{toolText(element.name) || toolText(element.role) || toolText(element.controlType)}</span>
      {typeof element.name === 'string' && (element.role || element.controlType) ? <span className="text-muted-foreground"> · {toolText(element.role) || toolText(element.controlType)}</span> : null}
      {properties.length > 0 && <p className="typography-micro text-muted-foreground">{properties.map((property, i) => <React.Fragment key={property.property}>{i > 0 ? ' · ' : ''}<span data-computer-property={property.property}>{property.text}</span></React.Fragment>)}</p>}
      {element.hasMoreChildren === true && <p className="typography-micro text-muted-foreground">{t('chat.tools.computer.moreChildren')}</p>}
    </li>;
  })}</ul>;
}

export function ChatComputerTool({ call, execution, result, status, generating, cwd, output, details }: ToolViewProps) {
  const { t } = useI18n(), conversation = useOptionalConversationPresentation();
  const action = useToolAction(call.id);
  const args = toolRecord(call.arguments), data = toolRecord(result?.details ?? execution?.result), response = toolRecord(data.result);
  const query = call.name === 'computer_query', awaiting = call.name === 'computer_await';
  const read = awaiting ? toolRecord(data.last) : data;
  const observation = toolRecord(read.observation ?? response.observation), control = toolRecord(data.control);
  const receipt = toolRecord(response.receipt);
  const semanticSummary = computerResultSummary(call.name, data, args, t);
  const hasPropertyResult = read.properties !== undefined || read.unavailableProperties !== undefined || receipt.observedState !== undefined;
  const properties = hasPropertyResult ? computerProperties(read.properties ?? receipt.observedState, read.unavailableProperties, args.properties, t) : [];
  const elements = list(observation.elements);
  const incomplete = read.complete === false || observation.complete === false;
  const moreResults = read.nextOffset != null || toolRecord(observation.treePage).nextOffset != null;
  const act = toolRecord(args.act ?? args.action), doc = toolRecord(response.doc), changes = toolRecord(response.changes), artifact = toolRecord(data.artifact);
  const desktop = toolRecord(data.desktop), request = toolRecord(data.request), version = toolRecord(data.version);
  const office = call.name.startsWith('computer_office'), browser = call.name.startsWith('computer_browser');
  const desktopId = toolText(data.desktopId) || toolText(desktop.id) || toolText(request.desktopId) || toolText(observation.desktopId) || toolText(artifact.desktopId) || toolText(control.desktopId) || toolText(args.desktopId);
  const label = office ? 'chat.tools.office' : browser ? 'chat.tools.browser' : call.name === 'computer_observe' ? 'chat.tools.observeComputer' : query ? 'chat.tools.queryComputer' : awaiting ? 'chat.tools.awaitComputer' : 'chat.tools.computer';
  const lines = Array.isArray(observation.treeLines) ? observation.treeLines : Array.isArray(response.lines) ? response.lines : [];
  const values = Array.isArray(changes.after) ? changes.after : Array.isArray(response.values) ? response.values : [];
  const before = Array.isArray(changes.before) ? changes.before.filter(Array.isArray) : undefined;
  const modified = typeof response.modified === 'boolean' ? response.modified : doc.modified;
  const registeredArtifact = ['id','desktopId','sourceHostId','scopeId','threadId','relativePath','sha256','modifiedAt','registeredAt'].every(key => typeof artifact[key] === 'string') && typeof artifact.byteLength === 'number';
  const openDesktop = (id: string) => useUIStore.getState().openContextPanelTab(cwd, { mode: 'computer', targetPath: id, dedupeKey: `desktop:${id}`, ...(conversation ? { thread: conversation.identity } : {}) });
  return <section className={office ? 'tool-office-activity' : 'tool-computer-event'}>
    <div className="tool-artifact-heading"><Icon name={office ? 'table-2' : browser ? 'global' : 'computer'} className="size-3.5 shrink-0" /><ToolHeadingText label={t(label)} subject={toolSubject(call, data, t)} receipt={semanticSummary} /><ToolStatus status={status} generating={generating} /></div>
    {office && (desktopId || typeof modified === 'boolean') && <div className="tool-office-heading typography-micro text-muted-foreground"><span>{desktopId}</span>
      {typeof modified === 'boolean' && <span className={modified ? 'text-[var(--status-warning)]' : ''}>{t(modified ? 'chat.tools.unsavedDocument' : 'chat.tools.saved')}</span>}</div>}
    {values.length > 0 && <OfficeGrid values={values.filter(Array.isArray)} before={before} range={toolText(changes.range) || toolText(response.range) || toolText(act.range)} />}
    {office && response.ok === true && act.kind === 'write' && !values.length && <p className="typography-meta">{t('chat.tools.documentWriteReturned')}</p>}
    {response.ok === true && typeof response.target === 'string' && <div className="tool-document-output"><Icon name={act.kind === 'export' ? 'file-pdf' : 'save'} className="size-4" /><div><p>{t(act.kind === 'export' ? 'chat.tools.exportedDocument' : act.kind === 'save' ? 'chat.tools.savedDocument' : 'chat.tools.documentTarget')}</p><code>{response.target}</code>{act.kind === 'export' && modified === true && <p className="typography-micro text-muted-foreground">{t('chat.tools.exportUnsaved')}</p>}</div></div>}
    {typeof response.text === 'string' && <ToolDisclosure id={'office-text:' + call.id} className="tool-document-text" initiallyExpanded><summary className="typography-micro text-muted-foreground">{t('chat.tools.observedContent')}</summary><pre className="tool-observation-text">{response.text}</pre></ToolDisclosure>}
    {list(response.docs).map((entry, i) => <div className="tool-material-row" key={toolText(entry.id) || i}><Icon name="file-text" className="size-4" /><div className="min-w-0 flex-1"><p>{toolText(entry.title)}</p><small className="tool-identity">{toolText(entry.url)}</small></div>{typeof entry.modified === 'boolean' && <span className="typography-micro">{t(entry.modified ? 'chat.tools.unsavedDocument' : 'chat.tools.saved')}</span>}</div>)}
    {list(response.tabs).map((tab, i) => <div key={toolText(tab.id) || i} className="tool-browser-tab"><Icon name="global" className="size-3.5" /><div><SourceLink url={toolText(tab.url)}>{toolText(tab.title) || toolText(tab.url)}</SourceLink><p className="typography-micro text-muted-foreground">{toolText(tab.url)}</p></div></div>)}
    {Boolean(observation.id) && <div className="tool-observation-heading"><span>{toolText(observation.windowTitle)}</span><span>{t('chat.tools.observedAt', { time: toolText(observation.capturedAt) })}</span></div>}
    {output}
    {awaiting && typeof data.elapsedMs === 'number' && <p className="typography-micro text-muted-foreground">{t('chat.tools.computer.elapsed', { seconds: Number((data.elapsedMs / 1000).toFixed(2)) })}</p>}
    {typeof observation.truncatedReason === 'string' && observation.truncatedReason !== read.reason && <p className="typography-micro text-muted-foreground">{observation.truncatedReason}</p>}
    {incomplete && <p className="typography-micro text-muted-foreground">{t('chat.tools.computer.incomplete')}</p>}
    {moreResults && !incomplete && <p className="typography-micro text-muted-foreground">{t('chat.tools.partialResult')}</p>}
    {(elements.length > 0 || lines.length > 0 || properties.length > 0) && <ToolDisclosure id={'computer-observation:' + call.id} className="tool-document-text">
      <summary className="typography-micro text-muted-foreground">{t(awaiting ? 'chat.tools.computer.lastObserved' : 'chat.tools.observedContent')}{elements.length > 0 ? ` · ${elements.length}` : ''}</summary>
      {properties.length > 0 && <ul className="space-y-1 typography-meta">{properties.map(property => <li key={property.property} className="whitespace-pre-wrap break-words" data-computer-property={property.property}>{property.text}</li>)}</ul>}
      {elements.length > 0 ? <ComputerElements elements={elements} /> : lines.length > 0 ? <pre className="tool-observation-text">{lines.filter(value => typeof value === 'string').join('\n')}</pre> : null}
      {(query || awaiting) && <p className="typography-micro text-muted-foreground">{t('chat.tools.computer.exposedScope')}</p>}
      {awaiting && typeof read.reason === 'string' && read.reason !== data.reason && <p className="typography-micro text-muted-foreground">{read.reason}</p>}
    </ToolDisclosure>}
    {call.name === 'computer_act' && typeof receipt.mechanism === 'string' && ['accessibility', 'global', 'app_post'].includes(receipt.mechanism) && <ToolDisclosure id={'computer-mechanism:' + call.id} className="tool-document-text">
      <summary className="typography-micro text-muted-foreground">{t('chat.tools.computer.mechanism')}</summary>
      <p className="typography-meta">{t(`chat.tools.computer.mechanism.${receipt.mechanism as 'accessibility' | 'global' | 'app_post'}`)}</p>
    </ToolDisclosure>}
    {call.name === 'computer_act' && response.inputWriterStopped === false && <p role="status" className="typography-meta text-[var(--status-warning)]">{t('chat.tools.computer.writerUnconfirmed')}</p>}
    {typeof toolRecord(receipt.reason).message === 'string' && toolRecord(receipt.reason).message !== response.detail && <p role="status" className="typography-meta text-muted-foreground">{toolText(toolRecord(receipt.reason).message)}</p>}
    {list(data.desktops ?? data.apps).map((item, index) => <div key={index} className="tool-material-row"><Icon name="computer" className="size-4" /><span className="flex-1 min-w-0">{toolText(item.label) || toolText(item.name)}<small className="block text-muted-foreground">{toolText(item.machineId) || toolText(item.windowTitle)}</small></span>{typeof item.status === 'string' && <span className="typography-micro">{toolValueLabel(item.status, t)}</span>}{Boolean(data.desktops) && typeof item.id === 'string' && conversation && <button type="button" className="tool-text-button" onClick={() => openDesktop(item.id as string)}>{t('chat.tools.openComputer')}</button>}</div>)}
    {list(data.results).map((item, index) => <div key={index} className="tool-install-receipt"><Icon name={item.state === 'installed' ? 'check' : 'error-warning'} className="size-3.5" /><span>{toolText(item.package) || toolText(item.name) || toolText(item.id)}</span><span>{toolValueLabel(item.state, t)}</span><p>{toolText(item.detail)}</p></div>)}
    {typeof desktop.label === 'string' && <div className="tool-material-row"><Icon name="computer" className="size-4" /><span className="flex-1 min-w-0">{desktop.label}<small className="block text-muted-foreground">{toolText(desktop.machineId)}</small></span><span className="typography-micro">{toolValueLabel(desktop.status, t)}</span></div>}
    {typeof request.status === 'string' && <div className="tool-control-record typography-meta"><span>{toolValueLabel(request.status, t)} · {toolText(request.access)}</span>{typeof request.reason === 'string' && <p>{request.reason}</p>}</div>}
    {call.name === 'computer_put' && typeof version.byteLength === 'number' && <div className="tool-document-output"><Icon name="file-text" className="size-4" /><div><p>{toolText(args.relativePath)}</p><span className="typography-micro text-muted-foreground">{version.byteLength} B · {toolText(version.modifiedAt)}</span></div></div>}
    {call.name === 'computer_environment' && <div className="tool-computer-placement"><ToolDisclosure id={'computer-source:' + call.id} className="tool-document-text"><summary className="typography-meta">{t('chat.tools.serviceLocation')}</summary><JsonSummaryView data={data.source} /></ToolDisclosure><ToolDisclosure id={'computer-assignment:' + call.id} className="tool-document-text"><summary className="typography-meta">{t('chat.tools.controlOwner')}</summary><JsonSummaryView data={data.assignment} /></ToolDisclosure></div>}
    {Array.isArray(data.entries) && <ToolDisclosure id={'computer-evidence:' + call.id} className="tool-document-text"><summary className="typography-meta">{t('chat.tools.triggerHistory')} · {data.entries.length}</summary><JsonSummaryView data={data.entries} /></ToolDisclosure>}
    {registeredArtifact && <div className="tool-document-output"><Icon name="file-text" className="size-4" /><div><p>{toolText(artifact.relativePath)}</p><span className="typography-micro text-muted-foreground">{String(artifact.byteLength)} B · {toolText(artifact.registeredAt)}</span></div><button type="button" className="tool-text-button" disabled={action.busy || !conversation} onClick={() => void action.run(() => downloadComputerArtifact(artifact as unknown as ComputerArtifact), () => {})}>{t('chat.tools.downloadFile')}</button></div>}
    {Object.keys(control).length > 0 && <div className="tool-control-record typography-meta"><span>{t('chat.tools.controlOwner')} · {toolText(control.owner)}</span>{control.transitioning === true && <span>{t('chat.tools.controlTransition')}</span>}{control.reachable === false && <span>{t('chat.tools.state.unavailable')}</span>}</div>}
    {data.released === true && <p className="typography-meta">{t('chat.tools.state.released')}</p>}
    {!semanticSummary && typeof response.outcome === 'string' && <p className="typography-meta text-[var(--status-warning)]">{toolValueLabel(response.outcome, t)}</p>}
    {!query && !awaiting && typeof data.status === 'string' && <p className="typography-meta">{toolValueLabel(data.status, t)}</p>}
    {typeof response.changesUnavailable === 'string' && <p className="typography-meta text-muted-foreground">{response.changesUnavailable}</p>}
    <ToolResultNotice data={data} status={status} /><ToolResultNotice data={response} status={response.ok === false ? 'error' : status} />
    {conversation && desktopId && <div className="tool-inline-actions"><button type="button" onClick={() => openDesktop(desktopId)}>{t('chat.tools.openComputer')}<Icon name="external-link" className="size-3" /></button></div>}
    {action.error && <p role="alert" className="typography-meta text-destructive">{action.error}</p>}{details}
  </section>;
}
