import type { BrowserAction, BrowserReadRequest } from '@varin/protocol';
import type { NativeBrowserOwner } from './native-owner.js';

type DesktopBrowserOwner = Pick<NativeBrowserOwner, 'present' | 'layout' | 'detach' | 'act' | 'read' | 'takeControl'>;
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid desktop browser arguments');
  return value as Record<string, unknown>;
};
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const point = (value: unknown): boolean => { const p = object(value); return number(p.x) && number(p.y); };
const action = (value: unknown): BrowserAction => {
  const input = object(value);
  let valid = input.ref === undefined || text(input.ref);
  valid &&= input.frameId === undefined || text(input.frameId);
  switch (input.action) {
    case 'navigate': valid &&= text(input.url); break;
    case 'back': case 'forward': case 'reload': case 'close': break;
    case 'click': case 'double_click': case 'hover': valid &&= text(input.ref) || point(input.point) && text(input.observationId); break;
    case 'scroll': valid &&= number(input.deltaY) && (input.deltaX === undefined || number(input.deltaX))
      && (input.point === undefined || point(input.point) && text(input.observationId)); break;
    case 'type': valid &&= typeof input.text === 'string' && (input.replace === undefined || typeof input.replace === 'boolean'); break;
    case 'press': valid &&= text(input.key) && (input.modifiers === undefined || Array.isArray(input.modifiers) && input.modifiers.every(key => ['Alt', 'Control', 'Meta', 'Shift'].includes(String(key)))); break;
    case 'select': valid &&= text(input.ref) && Array.isArray(input.values) && input.values.every(value => typeof value === 'string'); break;
    case 'check': valid &&= text(input.ref) && typeof input.checked === 'boolean'; break;
    case 'drag': valid &&= point(input.from) && point(input.to) && text(input.observationId); break;
    case 'dialog': valid &&= typeof input.accept === 'boolean' && (input.text === undefined || typeof input.text === 'string'); break;
    case 'evaluate': valid &&= typeof input.script === 'string'; break;
    case 'wait':
      valid &&= ['loaded', 'element', 'url', 'download'].includes(String(input.condition))
        && (input.timeoutMs === undefined || number(input.timeoutMs) && input.timeoutMs >= 0)
        && (input.condition !== 'element' || text(input.ref)) && (input.condition !== 'url' || text(input.url)) && (input.condition !== 'download' || text(input.downloadId));
      break;
    default: valid = false;
  }
  if (!valid) throw new Error('Invalid desktop browser action');
  return input as unknown as BrowserAction;
};

/** The shell authenticates the sender window. This port never admits arbitrary native methods. */
export async function invokeNativeBrowserCommand(owner: DesktopBrowserOwner, value: unknown): Promise<unknown> {
  const request = object(value), args = object(request.args);
  if (!text(request.windowLabel)) throw new Error('A trusted window label is required');
  const command = request.command;
  if (!['desktop_browser_present', 'desktop_browser_layout', 'desktop_browser_detach', 'desktop_browser_action', 'desktop_browser_read', 'desktop_browser_control'].includes(String(command))) {
    throw new Error('This desktop browser command is unavailable');
  }
  if (!text(args.pageId)) throw new Error('pageId is required');
  if (command === 'desktop_browser_action') return owner.act(args.pageId, action(args.action), undefined, true);
  if (command === 'desktop_browser_read') {
    if (args.view !== undefined && !['overview', 'text', 'structure', 'screenshot', 'find'].includes(String(args.view))) throw new Error('Invalid browser read view');
    for (const field of ['frameId', 'ref', 'query']) if (args[field] !== undefined && typeof args[field] !== 'string') throw new Error('Invalid browser read field');
    for (const field of ['offset', 'limit']) if (args[field] !== undefined && (!number(args[field]) || !Number.isSafeInteger(args[field]) || Number(args[field]) < (field === 'limit' ? 1 : 0))) throw new Error('Invalid browser read range');
    return owner.read(args as unknown as BrowserReadRequest);
  }
  if (command === 'desktop_browser_control') {
    if (typeof args.paused !== 'boolean') throw new Error('Browser control requires paused');
    return owner.takeControl(args.pageId, args.paused);
  }
  if (!text(args.viewId)) throw new Error('viewId is required');
  if (command === 'desktop_browser_detach') { await owner.detach(args.pageId, args.viewId, request.windowLabel); return null; }
  const raw = object(args.bounds);
  if (!['x', 'y', 'width', 'height'].every(key => number(raw[key]))) throw new Error('A finite browser viewport is required');
  const bounds = { x: Math.round(Number(raw.x)), y: Math.round(Number(raw.y)), width: Math.max(1, Math.round(Number(raw.width))), height: Math.max(1, Math.round(Number(raw.height))) };
  if (command === 'desktop_browser_layout') { await owner.layout(args.pageId, args.viewId, request.windowLabel, bounds, args.visible === true); return null; }
  return owner.present({ pageId: args.pageId, viewId: args.viewId, url: typeof args.url === 'string' ? args.url : 'about:blank', bounds, visible: args.visible === true }, request.windowLabel);
}
