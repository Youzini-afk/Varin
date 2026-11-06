import { defineSurfaceExtension, type VarinSurfaceMountContext } from '@varin/extension-sdk';
import type { VarinCredentialAuthorizationState } from '@varin/extension-contract';
import type { GmailConnection, GmailBinding } from './gmail.js';
type GmailAttempt = VarinCredentialAuthorizationState & { connectionId: string };
import { parseVarinExtensionManifest } from '@varin/extension-contract';
import rawManifest from './varin.extension.json' with { type: 'json' };
const manifest = parseVarinExtensionManifest(rawManifest);
export interface GmailSettings {
  list(): Promise<GmailConnection[]>;
  connect(): Promise<GmailAttempt>;
  readAttempt(connectionId: string, attemptId: string): Promise<GmailAttempt>;
  cancel(connectionId: string, attemptId: string): Promise<GmailAttempt>;
  reply(connectionId: string, attemptId: string, redirect: string): Promise<VarinCredentialAuthorizationState>;
  disconnect(input: { binding: GmailBinding; revoke: boolean }): Promise<{ revocation: string }>;
}
export function mountGmailSettings(container: HTMLElement, mount: Pick<VarinSurfaceMountContext, 'signal'>, service: GmailSettings | undefined) {
  const document = container.ownerDocument, page = document.createElement('section');
  page.className = 'gmail-settings';
  const heading = document.createElement('h2'); heading.textContent = 'Gmail';
  const info = document.createElement('p'); info.textContent = 'Connect your Gmail account on this Host. Every send or reply needs confirmation of its exact content. New-mail notifications and continuous listening are off; this plugin does not start either.';
  const status = document.createElement('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const error = document.createElement('p'); error.setAttribute('role', 'alert');
  const label = document.createElement('label'); label.textContent = 'Account';
  const select = document.createElement('select'); select.setAttribute('aria-label', 'Gmail account'); label.append(select);
  const details = document.createElement('pre'); details.className = 'gmail-account-details';
  const configLabel = document.createElement('label'); configLabel.textContent = 'Complete callback URL from your registered Google callback';
  const config = document.createElement('input'); config.placeholder = 'Paste the full callback URL after sign-in'; configLabel.append(config);
  const actions = document.createElement('div'); actions.className = 'gmail-actions';
  const button = (text: string) => { const node = document.createElement('button'); node.type = 'button'; node.textContent = text; actions.append(node); return node; };
  const connect = button('Connect Gmail'), refresh = button('Refresh accounts'), remove = button('Disconnect locally'), revoke = button('Revoke Google authorization'), cancel = button('Cancel sign-in'), submit = button('Complete sign-in');
  const link = document.createElement('a'); link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = 'Continue in Google'; link.hidden = true;
  page.append(heading, info, label, details, configLabel, actions, link, status, error); container.append(page);
  let closed = false, busy = false, accounts: GmailConnection[] = [], attempt: GmailAttempt | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  const alive = () => !closed && !mount.signal.aborted;
  const chosen = () => accounts.find(account => account.connectionId === select.value);
  const render = () => {
    if (!alive()) return;
    const selected = chosen();
    details.textContent = selected ? `${selected.accountId}\nTool binding: ${JSON.stringify({ connectionId: selected.connectionId, account: selected.account })}` : 'No Gmail account connected.';
    for (const item of [connect, refresh, remove, revoke, config, select]) item.disabled = busy || !service;
    remove.disabled ||= !selected; revoke.disabled ||= !selected;
    connect.disabled ||= !!attempt && ['pending'].includes(attempt.status);
    cancel.disabled = busy || !attempt || !['pending'].includes(attempt.status);
    submit.disabled = busy || !attempt || attempt.status !== 'pending';
    link.hidden = !attempt?.authorizationUrl || attempt.status !== 'pending';
    if (!link.hidden) link.href = attempt!.authorizationUrl!; else link.removeAttribute('href');
  };
  const load = async () => {
    const result = await service!.list(); if (!alive()) return;
    const previous = select.value; accounts = result; select.replaceChildren();
    for (const account of accounts) { const option = document.createElement('option'); option.value = account.connectionId; option.textContent = account.accountId; select.append(option); }
    if (accounts.some(account => account.connectionId === previous)) select.value = previous;
    render();
  };
  const run = async (work: () => Promise<void>) => {
    if (!alive() || busy || !service) return;
    busy = true; error.textContent = ''; render();
    try { await work(); }
    catch (failure) { if (alive()) error.textContent = failure instanceof Error ? failure.message : String(failure); }
    finally { busy = false; render(); }
  };
  const poll = () => {
    if (timer) clearTimeout(timer);
    if (!alive() || !attempt || !['pending'].includes(attempt.status)) return;
    timer = setTimeout(() => void run(async () => {
      const id = attempt!.id, next = await service!.readAttempt(attempt!.connectionId, id);
      if (!alive() || attempt?.id !== id) return;
      attempt = { ...next, connectionId: attempt!.connectionId }; status.textContent = `Sign-in: ${next.status}${next.message ? ` (${next.message})` : ''}`;
      if (next.status === 'completed') await load();
    }).finally(poll), 1500);
  };
  select.addEventListener('change', render);
  connect.addEventListener('click', () => void run(async () => {
    const next = await service!.connect();
    if (!alive()) { await service!.cancel(next.connectionId, next.id); return; }
    attempt = next; status.textContent = 'Open Continue in Google to finish sign-in. You can cancel this attempt without affecting other accounts.'; poll();
  }));
  submit.addEventListener('click', () => void run(async () => {
    if (!attempt || !config.value.trim()) return;
    await service!.reply(attempt.connectionId, attempt.id, config.value.trim());
    config.value = ''; status.textContent = 'Google callback submitted. Waiting for account verification.'; poll();
  }));
  refresh.addEventListener('click', () => void run(load));
  cancel.addEventListener('click', () => void run(async () => {
    if (!attempt) return; const id = attempt.id; const next = await service!.cancel(attempt.connectionId, id);
    if (alive() && attempt?.id === id) { attempt = { ...next, connectionId: attempt!.connectionId }; status.textContent = `Sign-in: ${next.status}`; }
  }));
  const disconnect = (shouldRevoke: boolean) => run(async () => {
    const account = chosen(); if (!account) return;
    const { connectionId, account: identity } = account;
    const result = await service!.disconnect({ binding: { connectionId, account: identity }, revoke: shouldRevoke });
    if (!alive()) return;
    status.textContent = `Local connection removed. Google revocation: ${result.revocation}.`; await load();
  });
  remove.addEventListener('click', () => void disconnect(false)); revoke.addEventListener('click', () => void disconnect(true));
  const close = () => {
    if (closed) return; closed = true;
    if (timer) clearTimeout(timer);
    const pending = attempt; attempt = undefined;
    if (pending && ['pending'].includes(pending.status)) void service?.cancel(pending.connectionId, pending.id).catch(() => {});
    page.remove(); mount.signal.removeEventListener('abort', close);
  };
  mount.signal.addEventListener('abort', close, { once: true });
  if (!service) { status.textContent = 'Gmail settings service is unavailable. Enable the plugin and review its Host account capability.'; render(); }
  else void run(load);
  return close;
}
export default defineSurfaceExtension(async context => {
  await context.styles.use('package/settings.css');
  const service = context.useService<GmailSettings>('varin.gmail.settings', 1);
  context.contribute(manifest.contributions![0]!, { mount: (container: HTMLElement, mount: VarinSurfaceMountContext) => mountGmailSettings(container, mount, service) });
});
