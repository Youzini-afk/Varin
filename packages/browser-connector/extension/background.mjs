import { TabConnector, CAPABILITIES } from './connector.mjs';
import { ConnectorBridge } from './transport.mjs';
import { parseConnectionLink, redeemConnection } from './pairing.mjs';
import { message as translate } from './i18n.mjs';

let connector;
let transport;
let connecting;
let status = translate('notConnected');
void chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
const notify = () => { void chrome.runtime.sendMessage({ type: 'state-changed' }).catch(() => {}); };
const report = value => { try { transport?.accept(value); } catch { void disconnect(); } };
async function connect() {
  if (connector && transport) return connector;
  if (connecting) return connecting;
  connecting = (async () => {
    const saved = await chrome.storage.local.get(['browserId', 'connection']);
    if (!saved.connection?.clientToken) throw new Error(translate('needsPairing'));
    const browserId = typeof saved.browserId === 'string' ? saved.browserId : `extension:${crypto.randomUUID()}`;
    if (!saved.browserId) await chrome.storage.local.set({ browserId });
    const instanceId = crypto.randomUUID();
    const current = new TabConnector({ chrome, browserId, instanceId,
      emit: event => { if (connector === current) { report({ type: 'event', event }); notify(); } } });
    const bridge = new ConnectorBridge({ endpoint: saved.connection.hostUrl, clientToken: saved.connection.clientToken, send: message => {
      if (connector !== current) return;
      if (message?.type === 'connected') { status = translate('connected'); notify(); }
      else if (message?.type === 'command') void current.execute(message.command).then(result => {
        if (connector === current) report({ type: 'result', result });
      });
      else if (message?.type === 'disconnected') { status = translate('interrupted'); void disconnect(false); }
    } });
    transport = bridge;
    connector = current; status = translate('connecting');
    report({ type: 'hello', browserId, instanceId, label: saved.connection.browserLabel || `${navigator.userAgent.includes('Edg/') ? 'Edge' : 'Chrome'} · ${translate('extensionType')}`, capabilities: CAPABILITIES });
    return current;
  })();
  try { return await connecting; } finally { connecting = undefined; }
}
async function disconnect(updateStatus = true) {
  const previous = connector; const bridge = transport;
  connector = undefined; transport = undefined;
  await previous?.stop();
  if (updateStatus) await bridge?.closeGracefully();
  else bridge?.stop();
  if (updateStatus) status = translate('disconnected');
  notify();
}
chrome.debugger.onDetach.addListener((source, reason) => connector?.detached(source.tabId, reason));
chrome.debugger.onEvent.addListener((source, method, params) => connector?.onEvent(source, method, params));
chrome.tabs.onRemoved.addListener(tabId => connector?.detached(tabId, 'target_closed'));
chrome.tabs.onUpdated.addListener((tabId, change) => connector?.changed(tabId, change));
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  // Only our own popup has consent controls. No content script/external caller can share a tab.
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html') || sender.tab) return false;
  const work = async () => {
    if (message?.action === 'state') {
      const { connection } = await chrome.storage.local.get('connection');
      return { status, connection: connection ? { label: connection.label, hostUrl: connection.hostUrl } : null,
        pages: connector ? await connector.dispatch({ method: 'list', args: [] }) : [] };
    }
    if (message?.action === 'pair') {
      const parsed = parseConnectionLink(message.link);
      const connection = await redeemConnection(parsed, message.hostUrl);
      await disconnect(); await chrome.storage.local.set({ connection }); status = translate('paired', connection.label);
      return { status };
    }
    if (message?.action === 'forget') { await disconnect(); await chrome.storage.local.remove('connection'); return { status }; }
    if (message?.action === 'disconnect') { await disconnect(); return { status, pages: [] }; }
    if (message?.action === 'share') {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error(translate('chooseTab'));
      const current = await connect();
      return { page: await current.share(tab.id), status };
    }
    if (message?.action === 'unshare') { await connector?.unshare(message.pageId); return { status }; }
    if (message?.action === 'pause') { await connector?.pause(message.pageId, message.paused === true); return { status }; }
    throw new Error('Unknown connector control');
  };
  void work().then(value => respond({ ok: true, ...value }), error => respond({ ok: false, error: error instanceof Error ? error.message : translate('unavailable') }));
  return true;
});
