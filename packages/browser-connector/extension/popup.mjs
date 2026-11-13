const status = document.querySelector('#status');
const pages = document.querySelector('#pages');
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
  const result = await send({ action: 'state' }); status.textContent = result.status;
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
void refresh().catch(error => { status.textContent = error.message; });
