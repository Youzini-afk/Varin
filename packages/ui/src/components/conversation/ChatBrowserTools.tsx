import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { isDesktopLocalOriginActive } from '@/lib/desktop';
import { ToolDisclosure, ToolStatus } from './ToolDisclosure';
import { ToolFileLink, ToolResultNotice } from './ChatResourceTools';
import { ToolHeadingText } from './ToolHeadingText';
import { toolRecord, toolText } from './toolInvocation';
import { subjectJoin, toolActionLabel, toolSubject } from './toolSubject';
import type { ToolViewProps } from './toolViewTypes';

export function ChatBrowserTool({ call, cwd, execution, result, status, generating, output, details }: ToolViewProps) {
  const { t } = useI18n();
  const args = toolRecord(call.arguments), data = toolRecord(result?.details ?? execution?.result), page = toolRecord(data.page);
  const label = toolActionLabel(call.name === 'browser_open' ? 'open' : call.name === 'browser_read' ? 'read'
    : call.name === 'browser_tabs' ? 'list' : args.action, t);
  const pages = Array.isArray(data.pages) ? data.pages.map(toolRecord) : page.pageId ? [page] : [];
  const elements = Array.isArray(data.elements) ? data.elements.map(toolRecord) : [];
  return <ToolDisclosure id={'tool:' + call.id} className="tool-file-activity group">
    <summary className="tool-resource-summary"><Icon name="global" className="size-3.5 shrink-0" />
      <ToolHeadingText label={label} subject={toolSubject(call, data, t)} /><ToolStatus status={status} generating={generating} />
      <Icon name="arrow-right-s" className="tool-disclosure-chevron size-3.5" /></summary>
    <div className="tool-file-results min-w-0">
      {pages.map(target => <button key={toolText(target.pageId)} type="button" className="tool-file-link max-w-full" disabled={!cwd || !isDesktopLocalOriginActive()}
        title={t('browser.openPage')} onClick={() => useUIStore.getState().openContextBrowser(cwd, toolText(target.url), toolText(target.pageId))}>
        <Icon name="global" className="size-3.5 shrink-0" /><span className="truncate">{toolText(target.title) || toolText(target.url)}</span><Icon name="arrow-right-up" className="size-3 shrink-0" />
      </button>)}
      {data.path && data.status === 'applied' ? <ToolFileLink callId={call.id} path={toolText(data.path)} /> : null}
      <ToolResultNotice data={data} status={status} />
      {Boolean(elements.length > 0 || data.text) && <div className="tool-result-scroll whitespace-pre-wrap break-words typography-meta" data-conversation-tool-scroll="true">
        {typeof data.text === 'string' ? data.text : elements.map((element, index) => <div key={toolText(element.ref) || index} className="mb-1">
          <span className="mr-2 typography-micro text-muted-foreground">{toolText(element.role)}</span>{subjectJoin(element.name, element.value)}
        </div>)}
      </div>}
      {output}{details}
    </div>
  </ToolDisclosure>;
}
