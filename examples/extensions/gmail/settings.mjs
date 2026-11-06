import { defineSurfaceExtension, defineSettingsPageMount } from '@varin/extension-sdk';
import manifest from './varin.extension.json' with { type: 'json' };

export function createSettingsExtension() {
  return defineSurfaceExtension(async context => {
    await context.styles.use('package/settings.css');
    const service = context.useService('example.gmail.connection', 1);
    if (!service) throw new Error('Gmail connection service is unavailable');
    context.contribute(manifest.contributions[0], defineSettingsPageMount((container, mount) => {
      const doc = container.ownerDocument;
      const zh = (doc.defaultView?.navigator?.language || '').toLowerCase().startsWith('zh');
      const text = (chinese, english) => zh ? chinese : english;
      const element = (tag, className, content) => {
        const node = doc.createElement(tag);
        if (className) node.className = className;
        if (content !== undefined) node.textContent = content;
        return node;
      };
      const root = element('section', 'varin-gmail');
      const heading = element('h1', 'varin-gmail-title', 'Gmail');
      const subtitle = element('p', 'varin-gmail-subtitle', text('连接你的 Gmail，在对话中搜索、阅读和发送邮件。', 'Connect Gmail to search, read and send mail from conversations.'));
      const statusBox = element('div', 'varin-gmail-card');
      const statusTitle = element('h2', 'varin-gmail-section-title', text('连接状态', 'Connection'));
      const status = element('p', 'varin-gmail-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
      const account = element('p', 'varin-gmail-account');
      const error = element('p', 'varin-gmail-error'); error.setAttribute('role', 'alert');
      const actions = element('div', 'varin-gmail-actions');
      const verify = element('button', 'varin-gmail-button secondary', text('验证连接', 'Verify connection')); verify.type = 'button';
      const disconnect = element('button', 'varin-gmail-button secondary', text('断开连接', 'Disconnect')); disconnect.type = 'button';
      const cancel = element('button', 'varin-gmail-button secondary', text('取消登录', 'Cancel sign-in')); cancel.type = 'button';
      const fallback = element('a', 'varin-gmail-link', text('浏览器没有打开？点此继续登录', 'Browser did not open? Continue sign-in')); fallback.target = '_blank'; fallback.rel = 'noopener noreferrer';
      actions.append(verify, disconnect, cancel, fallback);
      statusBox.append(statusTitle, status, account, error, actions);
      const setup = element('div', 'varin-gmail-card');
      const setupTitle = element('h2', 'varin-gmail-section-title', text('连接 Google 账号', 'Connect a Google account'));
      const explain = element('p', 'varin-gmail-copy');
      const configError = element('p', 'varin-gmail-error', text('发布者的 Gmail 登录配置不完整。请联系发布者或使用自己的客户端。', 'The publisher Gmail login is not configured correctly. Contact the publisher or use your own client.'));
      const manual = element('details', 'varin-gmail-copy');
      const manualTitle = element('summary', '', text('高级：使用自己的 OAuth 客户端', 'Advanced: use your own OAuth client'));
      const steps = element('ol', 'varin-gmail-steps');
      for (const item of [
        text('在 Google Cloud 启用 Gmail API，创建桌面应用 OAuth 客户端。', 'Enable the Gmail API in Google Cloud and create a Desktop OAuth client.'),
        text('在 OAuth 同意屏幕添加 Gmail 读取和发送权限，并把自己的账号加入测试用户。', 'Add Gmail read and send scopes to the consent screen and add your account as a test user.'),
        text('下载客户端 JSON，选择文件后连接。浏览器和 Varin 必须运行在同一台电脑。', 'Download the client JSON and select it below. The browser and Varin must be on the same computer.'),
      ]) steps.append(element('li', '', item));
      const docs = element('a', 'varin-gmail-link', text('查看 Google 授权设置说明', 'Google OAuth setup guide'));
      docs.href = 'https://developers.google.com/identity/protocols/oauth2/native-app'; docs.target = '_blank'; docs.rel = 'noopener noreferrer';
      const label = element('label', 'varin-gmail-label', text('Google OAuth 客户端 JSON', 'Google OAuth client JSON'));
      const file = element('input', 'varin-gmail-file'); file.type = 'file'; file.accept = '.json,application/json';
      label.append(file);
      const connect = element('button', 'varin-gmail-button primary', text('连接 Gmail', 'Connect Gmail')); connect.type = 'button';
      const privacy = element('p', 'varin-gmail-note', text('此扩展请求读取和发送邮件权限。客户端凭据和登录令牌保存在本机受限文件中，目前未使用系统密钥环。', 'This extension requests mail read and send access. Client credentials and tokens are stored in a restricted local file, not the OS keyring.'));
      manual.append(manualTitle, steps, docs, label);
      setup.append(setupTitle, explain, configError, manual, connect, privacy);
      root.append(heading, subtitle, statusBox, setup); container.append(root);
      let disposed = false, current = { phase: 'disconnected' }, busy = false, accountName = '', timer;
      const showError = value => { if (!disposed) error.textContent = value || ''; };
      const render = () => {
        if (disposed) return;
        const waiting = current.phase === 'authorizing', connected = current.phase === 'connected';
        status.textContent = waiting ? text('等待在浏览器中完成 Google 授权…', 'Waiting for Google authorization in your browser…')
          : connected ? text('已连接（可验证账号）', 'Connected (verify account to confirm)')
          : current.phase === 'error' ? text('连接未完成', 'Connection was not completed') : text('尚未连接', 'Not connected');
        account.textContent = accountName;
        verify.hidden = !connected; disconnect.hidden = !connected; cancel.hidden = !waiting;
        fallback.hidden = !waiting || !current.authorizationUrl;
        if (current.authorizationUrl) fallback.href = current.authorizationUrl;
        setup.hidden = waiting || connected;
        const publisherConfigured = current.publisherConfigured === true;
        explain.textContent = publisherConfigured
          ? text('点击连接，在系统浏览器中登录并授权自己的 Google 账号。', 'Connect and authorize your own Google account in your system browser.')
          : text('发布者尚未配置一键登录。可在高级选项导入自己的 Google 桌面 OAuth 客户端。', 'The publisher has not configured one-click login. You can import your own Desktop OAuth client in Advanced.');
        configError.hidden = !current.publisherConfigError;
        connect.disabled = busy || (!publisherConfigured && !file.files?.length);
        verify.disabled = disconnect.disabled = cancel.disabled = busy;
        if (current.message && !error.textContent) showError(current.message);
      };
      const refresh = async () => {
        try { current = await service.status(); render(); }
        catch { showError(text('无法读取 Gmail 插件状态。', 'Could not read the Gmail extension status.')); }
      };
      const run = async action => {
        if (busy) return;
        busy = true; showError(''); render();
        try { await action(); }
        catch (cause) { showError(cause instanceof Error ? cause.message : text('操作失败，请重试。', 'Operation failed; try again.')); }
        finally { busy = false; await refresh(); }
      };
      file.addEventListener('change', render);
      connect.addEventListener('click', () => void run(async () => {
        const selected = file.files?.[0];
        if (selected) {
          if (selected.size > 65536) throw new Error(text('请选择小于 64 KB 的 OAuth 客户端 JSON。', 'Choose an OAuth client JSON smaller than 64 KB.'));
          await service.start(await selected.text());
        } else {
          await service.start();
        }
        file.value = '';
      }));
      cancel.addEventListener('click', () => void run(async () => { await service.cancel(); accountName = ''; }));
      verify.addEventListener('click', () => void run(async () => {
        const profile = await service.check();
        accountName = `${text('当前账号', 'Account')}: ${profile.emailAddress}`;
      }));
      disconnect.addEventListener('click', () => void run(async () => { await service.disconnect(); accountName = ''; }));
      const onAbort = () => { disposed = true; clearInterval(timer); root.remove(); };
      mount.signal.addEventListener('abort', onAbort, { once: true });
      render(); void refresh();
      timer = setInterval(() => { if (!busy && current.phase === 'authorizing') void refresh(); }, 1500);
      return () => { mount.signal.removeEventListener('abort', onAbort); onAbort(); };
    }));
  });
}
export default createSettingsExtension();
