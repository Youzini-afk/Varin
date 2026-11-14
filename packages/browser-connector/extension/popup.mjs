import { parseConnectionLink } from './pairing.mjs';
import { message, localizeDocument } from './i18n.mjs';
localizeDocument();
const status = document.querySelector('#status');
const pages = document.querySelector('#pages');
let refreshSequence = 0;
const linkInput = document.querySelector('#pair-link');
const hostSelect = document.querySelector('#host-address');
linkInput.addEventListener('input', () => {
  try { const link = parseConnectionLink(linkInput.value); hostSelect.replaceChildren(...link.candidates.map(candidate => new Option(candidate.url, candidate.url))); }
  catch { hostSelect.replaceChildren(); }
});
document.querySelector('#pair-form').addEventListener('submit', event => {
  event.preventDefault();
  void (async () => {
    try {
      const parsed = parseConnectionLink(linkInput.value);
      const hostUrl = hostSelect.value || parsed.candidates[0].url;
      const allowed = await chrome.permissions.request({ origins: [`${new URL(hostUrl).origin}/*`] });
      if (!allowed) throw new Error(message('permissionDenied'));
      await send({ action: 'pair', link: linkInput.value, hostUrl }); linkInput.value = ''; await refresh();
    } catch (error) { status.textContent = error.message; }
  })();
});
const send = async request => {
  const result = await chrome.runtime.sendMessage(request);
  if (!result?.ok) throw new Error(result?.error || message('unavailable'));
  return result;
};
const control = (label, message) => {
  const button = document.createElement('button'); button.textContent = label;
  button.addEventListener('click', () => void run(message)); return button;
};
async function refresh() {
  const sequence = ++refreshSequence, result = await send({ action: 'state' });
  if (sequence !== refreshSequence) return;
  status.textContent = result.status;
  document.querySelector('#setup').hidden = !!result.connection;
  document.querySelector('#connected').hidden = !result.connection;
  document.querySelector('#connection-name').textContent = result.connection ? `${result.connection.label} · ${new URL(result.connection.hostUrl).host}` : message('connect');
  pages.replaceChildren(...result.pages.map(page => {
    const item = document.createElement('li');
    const title = document.createElement('strong'); title.textContent = page.title || page.url;
    const url = document.createElement('div'); url.textContent = page.url;
    item.append(title, url,
      control(message(page.agentPaused ? 'resume' : 'pause'), { action: 'pause', pageId: page.pageId, paused: !page.agentPaused }),
      control(message('stopSharing'), { action: 'unshare', pageId: page.pageId }));
    return item;
  }));
}
async function run(message) {
  try { await send(message); await refresh(); } catch (error) { status.textContent = error.message; }
}
document.querySelector('#share').addEventListener('click', () => void run({ action: 'share' }));
document.querySelector('#disconnect').addEventListener('click', () => void run({ action: 'disconnect' }));
document.querySelector('#forget').addEventListener('click', () => void run({ action: 'forget' }));
chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender.id === chrome.runtime.id && message?.type === 'state-changed') void refresh().catch(error => { status.textContent = error.message; });
});
void refresh().catch(error => { status.textContent = error.message; });
