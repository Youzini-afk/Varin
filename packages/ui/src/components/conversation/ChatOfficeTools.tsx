import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { ThreadMaterialLinks } from '@/components/thread/ThreadMaterials';
import { ToolDisclosure, ToolStatus } from './ToolDisclosure';
import { ToolFileLink, ToolResultNotice } from './ChatResourceTools';
import { ToolHeadingText } from './ToolHeadingText';
import { toolRecord, toolText } from './toolInvocation';
import { subjectJoin, toolSubject } from './toolSubject';
import type { ToolViewProps } from './toolViewTypes';

/** A file operation stays a file operation in the timeline, with its actual range and receipt. */
export function ChatOfficeTool({ call, execution, result, status, generating, output, details }: ToolViewProps) {
  const { t } = useI18n();
  const args = toolRecord(call.arguments), data = toolRecord(result?.details ?? execution?.result);
  const label = t(call.name === 'office_write' ? 'chat.dialogue.edit' : call.name === 'office_export' ? 'chat.toolAction.export'
    : call.name === 'office_render' ? 'office.reader.preview' : call.name === 'office_environment' ? 'chat.toolAction.inspect' : 'chat.dialogue.document');
  const sections = Array.isArray(data.sections) ? data.sections.map(toolRecord) : [];
  const objects = Array.isArray(data.objects) ? data.objects.map(toolRecord) : [];
  const path = toolText(args.path), engine = toolRecord(data.engine);
  return <ToolDisclosure id={'tool:' + call.id} className="tool-file-activity group">
    <summary className="tool-resource-summary">
      <Icon name="file-text" className="size-3.5 shrink-0" />
      <ToolHeadingText label={label} subject={toolSubject(call, data, t)} receipt={toolText(data.format).toUpperCase()} />
      <ToolStatus status={status} generating={generating} /><Icon name="arrow-right-s" className="tool-disclosure-chevron size-3.5" />
    </summary>
    <div className="tool-file-results min-w-0">
      {path && !generating && <ToolFileLink callId={call.id} path={path} />}
      <ThreadMaterialLinks data={data} />
      <ToolResultNotice data={data} status={status} />
      {data.requiresRecalculation === true && <p className="typography-micro text-muted-foreground">{t('office.reader.needsRecalculation')}</p>}
      {Boolean(engine.name || engine.version) && <p className="typography-micro text-muted-foreground">{subjectJoin(engine.name, engine.version)}</p>}
      {(objects.length > 0 || sections.length > 0) && <div className="tool-result-scroll" data-conversation-tool-scroll="true">
        {objects.length ? objects.map((item, index) => <div key={toolText(item.id) || index} className="mb-2 min-w-0 whitespace-pre-wrap break-words typography-meta">
          {item.address ? <span className="mr-2 font-mono text-muted-foreground">{toolText(item.address)}</span> : null}
          {typeof item.text === 'string' ? item.text : item.formula ? `=${toolText(toolRecord(item.formula).text)}` : String(item.value ?? '')}
          {Array.isArray(item.rows) && <table className="w-full table-fixed border-collapse"><tbody>{item.rows.map((row, rowIndex) => <tr key={rowIndex}>
            {(Array.isArray(toolRecord(row).cells) ? toolRecord(row).cells as unknown[] : []).map((cell, cellIndex) => <td key={cellIndex} className="break-words border border-border/50 p-2 align-top">{toolText(toolRecord(cell).text)}</td>)}
          </tr>)}</tbody></table>}
        </div>) : sections.map(item => <div key={toolText(item.id)} className="break-words typography-meta">{toolText(item.name)}</div>)}
      </div>}
      {status === 'error' && output}{details}
    </div>
  </ToolDisclosure>;
}
