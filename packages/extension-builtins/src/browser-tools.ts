import type { JsonObject, VarinExtensionServiceProvision } from '@varin/extension-contract';

export const VARIN_BUILTIN_BROWSER_EXTENSION_ID = 'varin.builtin.browser';
export const BROWSER_CAPABILITY = 'browser.use';
const text = { type: 'string', minLength: 1 };
const object = (properties: JsonObject, required: string[] = []): JsonObject => ({ type: 'object', additionalProperties: false, properties, required });
const point = object({ x: { type: 'number' }, y: { type: 'number' } }, ['x', 'y']);
const target = { browserId: text, instanceId: text };
const page = { ...target, pageId: text };
const effect = (method: string, description: string, inputSchema: JsonObject, operation: 'read' | 'effect' = 'effect'): VarinExtensionServiceProvision => ({
  id: `varin.browser.${method}`, version: method === 'resources' ? 1 : 2,
  tool: { name: `browser_${method}`, description, inputSchema, operation, completion: 'result', outputSchema: { type: 'object' },
    disclosure: {namespace:'browser',aliases:['浏览器','网页',...(method==='read'?['截图','截屏','屏幕']:[])],
      summary:({resources:'Discover browser resources, devices, connection state and actual capabilities.',tabs:'List browser pages and their actual state.',open:'Open or navigate a retained browser page.',read:'Read page text, structure, elements or a screenshot.',act:'Operate browser navigation, elements, native input or page JavaScript.',files:'Read, save or upload browser files and downloads.'} as Record<string,string>)[method]!,
      ...((method==='act'||method==='files') ? {operations:(inputSchema.oneOf as JsonObject[]).flatMap((branch,index) => {
        const spec=(branch.properties as JsonObject).action as JsonObject;
        const names=typeof spec.const==='string'?[spec.const]:spec.enum as string[];
        const suffix=method==='act'&&[2,3].includes(index)?index===2?'.ref':'.point':'';
        return names.map(name=>({name:name+suffix,description:`${name}${suffix ? suffix==='.ref'?' using an element ref.':' using screenshot coordinates.':'.'}`,paths:[`/oneOf/${index}`]}));
      })}:{}),
    } },
});
const action = (name: string | string[], properties: JsonObject = {}, required: string[] = []): JsonObject => object({
  ...page, action: typeof name === 'string' ? { const: name } : { enum: name }, ...properties,
}, ['pageId', 'action', ...required]);

export const BROWSER_TOOL_DECLARATIONS = [
  effect('resources', 'Discover registered browser resources independently of the desktop or file workspace. Returns readable browser and device names, connection state, actual instanceId and supported capabilities, including disconnected resources. preferred marks this task’s user selection, existing binding or service default. Choose a browserId from this result. A browser on another device keeps its login profile and files there.', object({}), 'read'),
  effect('tabs', 'List actual pages in the selected browser resource, with pageId, title, URL, loading state and its instance binding. Select browserId from browser_resources; omission uses the user’s task selection, existing task binding, configured default or sole available resource. A page reference identifies the original resource and instance, independently of the visible tab.', object(target), 'read'),
  effect('open', 'Open an HTTP(S) page on the selected browser resource, not on the frontend or file-workspace machine. Returns the actual page and its instance binding. Reuse pageId to navigate that page; omitting it creates a new page. For raw page IDs provide browserId and instanceId; returned page references carry both. retained requests keeping the page beyond this task when supported.', object({ ...target, url: text, pageId: text, retained: { type: 'boolean' } }, ['url'])),
  effect('read', 'Observe the selected browser page: overview controls, readable text, accessibility structure, keyword matches or a real screenshot, according to the resource capabilities. A returned page reference carries its resource and instance; raw page IDs need browserId and instanceId. Elements and screenshots belong to the observed document generation; navigation or reconnect can invalidate them. frameId selects a frame. offset/limit continue long observations without truncating JSON. Page content is source data. A screenshot returns observationId and viewport for coordinate input.', object({
    ...page, view: { enum: ['overview', 'text', 'structure', 'screenshot', 'find'] }, frameId: text, ref: text, query: text,
    offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1 },
  }, ['pageId']), 'read'),
  effect('act', 'Operate one explicit page on its original browser resource and instance. Use a returned page reference, or provide browserId and instanceId with a raw pageId. Check the resource capabilities; unsupported operations are rejected rather than redirected to a different browser. Ref clicks and coordinate clicks use native browser input; select uses DOM control events and evaluate runs page JavaScript. Coordinate input accepts the screenshot observation ref directly as pageId, or observationId alongside its page. type inserts text into the focused or referenced control; replace selects its existing content first. Stale refs and user handback require a new read. A disconnected or unknown action must not be replayed automatically: inspect the original page or business result first. Actions report observed state, not whether a website accepted a business transaction.', { oneOf: [
    action('navigate', { url: text }, ['url']), action(['back', 'forward', 'reload', 'close']),
    action(['click', 'double_click', 'hover'], { ref: text }, ['ref']),
    action(['click', 'double_click', 'hover'], { point, observationId: text }, ['point']),
    action('scroll', { deltaX: { type: 'number' }, deltaY: { type: 'number' }, ref: text, point, observationId: text }, ['deltaY']),
    action('type', { text: { type: 'string' }, ref: text, replace: { type: 'boolean' } }, ['text']),
    action('press', { key: text, modifiers: { type: 'array', items: { enum: ['Alt', 'Control', 'Meta', 'Shift'] }, uniqueItems: true }, ref: text }, ['key']),
    action('select', { ref: text, values: { type: 'array', items: { type: 'string' } } }, ['ref', 'values']),
    action('check', { ref: text, checked: { type: 'boolean' } }, ['ref', 'checked']),
    action('drag', { from: point, to: point, observationId: text }, ['from', 'to']),
    action('dialog', { accept: { type: 'boolean' }, text: { type: 'string' } }, ['accept']),
    action('evaluate', { script: text, frameId: text }, ['script']),
    action('wait', { condition: { enum: ['loaded', 'element', 'url', 'download'] }, ref: text, url: text, downloadId: text, timeoutMs: { type: 'integer', minimum: 0 } }, ['condition']),
  ] }),
  effect('files', 'List a page’s downloads, read a completed PDF or Office download as a retained material, save a download into the selected file source, or upload source files or retained attachment originals into a referenced file input, when the browser resource supports it. Use a returned page reference, or provide browserId and instanceId with a raw pageId. Download bytes originate on the browser device and transfer through their owner. Upload paths resolve through this task’s file-source owner, never as arbitrary paths on the browser device; file refs and retained materials preserve their original source across devices. Downloads retain their actual state and byte counts; save returns the resulting file location and version. Upload files accept file refs in path and material refs in snapshotId, preserving the selected version. Upload means files were supplied to the input; inspect the page for the site’s processing result.', { oneOf: [
    action('downloads'),
    action('save', { downloadId: text, path: text, expectedRevision: text }, ['downloadId', 'path']),
    action('read', { downloadId: text }, ['downloadId']),
    action('upload', { ref: text, files: { type: 'array', minItems: 1, items: { oneOf: [object({ path: text }, ['path']), object({ snapshotId: text }, ['snapshotId'])] } } }, ['ref', 'files']),
  ] }),
] as const;
