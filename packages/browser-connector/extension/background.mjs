import { TabConnector, CAPABILITIES } from './connector.mjs';

let connector;
let port;
let connecting;
let status = 'Not connected';
const report = value => { try { port?.postMessage(value); } catch { void disconnect(); } };
async function connect() {
  if (connector && port) return connector;
  if (connecting) return connecting;
  connecting = (async () => {
    const saved = await chrome.storage.local.get('browserId');
    const browserId = typeof saved.browserId === 'string' ? saved.browserId : `extension:${crypto.randomUUID()}`;
    if (!saved.browserId) await chrome.storage.local.set({ browserId });
    const instanceId = crypto.randomUUID();
    const current = new TabConnector({ chrome, browserId, instanceId,
      emit: event => { if (connector === current) report({ type: 'event', event }); } });
    const native = chrome.runtime.connectNative('org.varin.browser_connector');
    connector = current; port = native; status = 'Connecting to the paired Host';
    native.onMessage.addListener(message => {
      if (connector !== current) return;
      if (message?.type === 'connected') status = 'Connected';
      else if (message?.type === 'command') void current.execute(message.command).then(result => {
        if (connector === current) report({ type: 'result', result });
      });
      else if (message?.type === 'disconnected') { status = 'Host connection interrupted. Reconnect and share tabs again.'; void disconnect(false); }
    });
    native.onDisconnect.addListener(() => {
      // Reading lastError prevents Chrome logging it; credentials and page contents never enter logs.
      void chrome.runtime.lastError;
      if (connector === current) { status = 'Native helper disconnected. Reconnect and share tabs again.'; void disconnect(false); }
    });
    report({ type: 'hello', browserId, instanceId, label: `${navigator.userAgent.includes('Edg/') ? 'Edge' : 'Chrome'} shared tabs`, capabilities: CAPABILITIES });
    return current;
  })();
  try { return await connecting; } finally { connecting = undefined; }
}
async function disconnect(updateStatus = true) {
  const previous = connector; const native = port;
  connector = undefined; port = undefined;
  await previous?.stop();
  if (updateStatus && native) {
    try { native.postMessage({ type: 'goodbye' }); } catch { native.disconnect(); }
  } else native?.disconnect();
  if (updateStatus) status = 'Disconnected. All shared tabs released.';
}
chrome.debugger.onDetach.addListener((source, reason) => connector?.detached(source.tabId, reason));
chrome.debugger.onEvent.addListener((source, method, params) => connector?.onEvent(source, method, params));
chrome.tabs.onRemoved.addListener(tabId => connector?.detached(tabId, 'target_closed'));
chrome.tabs.onUpdated.addListener((tabId, change) => connector?.changed(tabId, change));
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  // Only our own popup has consent controls. No content script/external caller can share a tab.
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html') || sender.tab) return false;
  const work = async () => {
    if (message?.action === 'state') return { status, pages: connector ? await connector.dispatch({ method: 'list', args: [] }) : [] };
    if (message?.action === 'disconnect') { await disconnect(); return { status, pages: [] }; }
    if (message?.action === 'share') {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error('Select a normal browser tab');
      const current = await connect();
      return { page: await current.share(tab.id), status };
    }
    if (message?.action === 'unshare') { await connector?.unshare(message.pageId); return { status }; }
    if (message?.action === 'pause') { await connector?.pause(message.pageId, message.paused === true); return { status }; }
    throw new Error('Unknown connector control');
  };
  void work().then(value => respond({ ok: true, ...value }), error => respond({ ok: false, error: error instanceof Error ? error.message : 'Connector failed' }));
  return true;
});
