import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ProjectFileContext } from '@/hooks/useProjectFileLocation';
const mocks = vi.hoisted(() => ({ context: null as unknown as ProjectFileContext, request: vi.fn(), local: vi.fn(), content: vi.fn(), open: vi.fn(), navigate: vi.fn() }));
vi.mock('@varin/application-client', async original => ({ ...await original<typeof import('@varin/application-client')>(), createResourceFilesHttpAPI: () => ({ request: mocks.request }) }));
vi.mock('@/hooks/useProjectFileLocation', () => ({ useProjectFileLocation: () => mocks.context }));
vi.mock('@/hooks/useRuntimeAPIs', () => { const apis = { files: { search: mocks.local }, workspaceSearch: { searchContent: mocks.content } }; return { useRuntimeAPIs: () => apis }; });
vi.mock('@/lib/extensions/workbench-workspace', () => ({ useWorkbenchWorkspaceId: () => `view:${mocks.context.key}` }));
vi.mock('@/lib/workbench/editors/resource-workspace', () => ({ openProjectResourceFile: mocks.open, resolveProjectEditorWorkspace: () => ({ documentWorkspaceId: 'target-documents' }) }));
vi.mock('@/lib/workbench/editors/session', () => ({ openWorkbenchEditor: vi.fn() }));
vi.mock('@/lib/workbench/editors/groups', () => ({ activeEditorTab: () => ({ viewId: 'target-view' }) }));
vi.mock('@/lib/monaco/editor-command-service', () => ({ requestFileEditorNavigation: mocks.navigate }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string, values?: {message?: string}) => `${key}${values?.message ?? ''}` }) }));
vi.mock('@/components/ui/button', () => ({ Button: ({ children, variant: _variant, size: _size, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & {variant?:string;size?:string}) => <button {...props}>{children}</button> }));
vi.mock('@/components/ui/input', () => ({ Input: React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>((props, ref) => <input {...props} ref={ref} />) }));
vi.mock('@tanstack/react-virtual', () => ({ useVirtualizer: ({ count }: {count:number}) => ({ getTotalSize: () => count * 52, getVirtualItems: () => Array.from({length:count}, (_,index) => ({index,key:index,size:52,start:index*52})) }) }));
import { IdeSearchPanel } from './IdeSearchPanel';
let root: Root, container: HTMLElement;
const context = (host: string): ProjectFileContext => ({ remote: true, loading: false, key: host, root: '/same/path', retry: vi.fn(), location: { projectId: 'project', resourceOwner: { kind:'managed_host',hostId:host,connectionId:`pair-${host}`,endpointIdentity:`endpoint-${host}` }, workspaceId:'target-documents',root:'/same/path' } });
beforeEach(() => { vi.useFakeTimers(); const { window, document } = parseHTML('<html><body></body></html>'); window.setTimeout = globalThis.setTimeout; window.clearTimeout = globalThis.clearTimeout; for (const [key,value] of Object.entries({window,document,HTMLElement:window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true})) vi.stubGlobal(key,value); container=document.createElement('div'); document.body.append(container); root=createRoot(container); mocks.context=context('a'); mocks.request.mockReset(); mocks.local.mockReset(); mocks.content.mockReset(); mocks.open.mockReset(); mocks.navigate.mockReset(); });
afterEach(async () => { await act(async () => root.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function render(mode:'files'|'content'='files') { await act(async () => root.render(<IdeSearchPanel key={mocks.context.key} directory="/coordinator/old" mode={mode} query="needle" focusRequestId={0} onModeChange={()=>{}} onQueryChange={()=>{}} />)); await act(async () => vi.advanceTimersByTimeAsync(251)); }
function click(text:string) { const button=Array.from(container.querySelectorAll('button')).find(item=>item.textContent===text); expect(button).toBeTruthy(); button!.click(); }
it('opens a nested filename through the same target owner and reports incomplete enumeration', async () => {
  mocks.request.mockResolvedValue({kind:'filename-search',enumerationStatus:'incomplete',results:[{path:'deep/needle.ts'}]}); await render();
  expect(mocks.request.mock.calls[0][0]).toMatchObject({resourceOwner:mocks.context.location!.resourceOwner,workspaceId:'target-documents',command:{kind:'filename-search',path:'',query:'needle'}});
  expect(container.textContent).toContain('files.search.incomplete'); await act(async () => click('/same/path/deep/needle.ts'));
  expect(mocks.open).toHaveBeenCalledWith(mocks.context.location,'deep/needle.ts',{target:'editor'}); expect(mocks.local).not.toHaveBeenCalled();
});
it('opens recursive content at the target Documents identity and specific editor view', async () => {
  mocks.request.mockResolvedValue({kind:'content-search',result:{status:'ready',hits:[{resource:{workspaceId:'target-documents',resourceId:'deep/a.ts'},line:12,column:3,preview:'needle'}],incomplete:true}}); await render('content');
  expect(container.textContent).toContain('deep/a.ts:12'); const button=Array.from(container.querySelectorAll('button')).find(item=>item.textContent?.includes('deep/a.ts:12')); await act(async () => button!.click());
  expect(mocks.open).toHaveBeenCalledWith(mocks.context.location,'deep/a.ts',{target:'editor'}); expect(mocks.navigate).toHaveBeenCalledWith({workspaceId:'target-documents',resourceId:'deep/a.ts'},12,3,'target-view'); expect(mocks.content).not.toHaveBeenCalled();
});
it('cancels old observation and ignores its late response after a same-path owner switch', async () => {
  const pending:Array<(value:unknown)=>void>=[]; mocks.request.mockImplementation(()=>new Promise(resolve=>pending.push(resolve))); await render(); const signal=mocks.request.mock.calls[0][1] as AbortSignal;
  mocks.context=context('b'); await render(); expect(signal.aborted).toBe(true);
  await act(async () => pending[0]({kind:'filename-search',enumerationStatus:'complete',results:[{path:'old.ts'}]})); expect(container.textContent).not.toContain('old.ts');
  await act(async () => pending[1]({kind:'filename-search',enumerationStatus:'complete',results:[{path:'new.ts'}]})); await act(async () => click('/same/path/new.ts'));
  expect(mocks.open.mock.calls[0][0].resourceOwner.hostId).toBe('b');
});
it.each(['failed','cancelled'])('never publishes %s computation as empty or successful results', async status => {
  mocks.request.mockResolvedValue({kind:'filename-search',enumerationStatus:status,results:[{path:'partial.ts'}]}); await render(); expect(container.textContent).not.toContain('partial.ts'); expect(container.textContent).not.toContain('workbench.ide.search.empty'); if(status==='failed')expect(container.textContent).toContain('Source filename search failed');
});
