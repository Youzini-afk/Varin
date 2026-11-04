/** Shared UI remains browser-first; only a Tauri-owned top-level view loads the adapter. */
export async function prepareDesktopRenderer(): Promise<void> {
  if (!('__TAURI_INTERNALS__' in window) || window.top !== window) return;
  try {
    const { initializeTauriDesktop } = await import('@varin/tauri/bootstrap');
    await initializeTauriDesktop();
  } catch (error) {
    // Do not configure same-origin Web APIs after native startup failed. That
    // would hide the selected remote identity and leave a misleading splash.
    const root = document.getElementById('root');
    if (root) {
      const notice = document.createElement('p');
      notice.setAttribute('role', 'alert');
      const failure=typeof error==='string'?error:error instanceof Error?error.message:'';
      if(failure==='varin:legacy-transition-required'){
        const chinese=navigator.language.toLowerCase().startsWith('zh');
        notice.textContent=chinese?'检测到尚未处理的旧版桌面资料。此单引擎版本未包含受控迁移工具，尚未启动新的本地服务。原数据已保留。请从 Varin 原发布页安装签名过的 Electron → Tauri 过渡版本，完成迁移后再使用此版本。不要选择来历不明的程序。':'Previous desktop data needs the signed transition release before this single-engine version can open it. No new local service has started, and your original data is intact. Install the Electron → Tauri transition release from Varin’s original releases page, then return to this version. Do not select an unverified executable.';
        const link=document.createElement('a');link.href='https://github.com/Youzini-afk/Varin/releases';link.target='_blank';link.rel='noopener noreferrer';link.textContent=chinese?'打开 Varin 原发布页':'Open Varin’s original releases';
        root.replaceChildren(notice,link);
      }else{notice.textContent=navigator.language.toLowerCase().startsWith('zh')?'Varin 启动失败。请退出应用后重新打开。':'Varin could not initialize this desktop window. Quit and reopen the app to retry.';root.replaceChildren(notice);}
      // React never mounts on this path, so it cannot retire the pre-paint cover.
      document.getElementById('initial-loading')?.remove();
    }
    throw error;
  }
}
