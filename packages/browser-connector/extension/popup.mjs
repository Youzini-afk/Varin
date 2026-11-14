import { parseConnectionLink } from './pairing.mjs';
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
      if (!allowed) throw new Error('Allow access to your selected Varin service to connect.');
      await send({ action: 'pair', link: linkInput.value, hostUrl }); linkInput.value = ''; await refresh();
    } catch (error) { status.textContent = error.message; }
  })();
});
const send = async message => {
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) throw new Error(result?.error || 'The browser connector is unavailable');
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
  document.querySelector('#connection-name').textContent = result.connection ? `${result.connection.label} · ${new URL(result.connection.hostUrl).host}` : 'Connect to your Varin service';
  pages.replaceChildren(...result.pages.map(page => {
    const item = document.createElement('li');
    const title = document.createElement('strong'); title.textContent = page.title || page.url;
    const url = document.createElement('div'); url.textContent = page.url;
    item.append(title, url,
      control(page.agentPaused ? 'Resume task' : 'Pause for my control', { action: 'pause', pageId: page.pageId, paused: !page.agentPaused }),
      control('Stop sharing', { action: 'unshare', pageId: page.pageId }));
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
