/* Run only with the explicitly prepared repository-pinned original Electron.
 * Creates/reads a synthetic profile using the original engine's native owners.
 * Actual secrets, Chromium database files and website network are never read. */
const {app, BrowserWindow, protocol, session} = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const flag = process.argv.indexOf('--varin-installer-fixture');
const [mode, root, nonce, expectedProfile] = process.argv.slice(flag + 1);
const origin = 'https://migration-fixture.invalid';
const windows = [];
let resultFile;
const inert = () => new Response('<!doctype html><title>Varin synthetic migration fixture</title>', {headers:{'Content-Type':'text/html','Content-Security-Policy':"default-src 'none'; script-src 'none'; connect-src 'none'; worker-src 'none'"}});
const samePath = (a,b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
async function request(window, method, params = {}) { return window.webContents.debugger.sendCommand(method, params); }
async function open(profile, url) {
  const window = new BrowserWindow({show:false,webPreferences:{session:profile,nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}});
  windows.push(window);window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  await window.loadURL(url);window.webContents.debugger.attach('1.3');return window;
}
async function storage(window, origin, entries) {
  const storageId={securityOrigin:origin,isLocalStorage:true};
  if(mode==='seed')for(const[key,value]of entries)await request(window,'DOMStorage.setDOMStorageItem',{storageId,key,value});
  const result = new Map((await request(window,'DOMStorage.getDOMStorageItems',{storageId})).entries);
  if(entries.some(([key,value])=>result.get(key)!==value))throw new Error('Synthetic native storage readback differs');
}
(async()=>{
  if(flag<1||!['seed','verify'].includes(mode)||!process.versions.electron||!/^[0-9a-f-]{36}$/u.test(nonce??'')
    ||process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_ENVIRONMENT!=='github-hosted')throw new Error('Requires a disposable GitHub-hosted Electron fixture invocation');
  const resolved = await fs.realpath(root), temporary = await fs.realpath(os.tmpdir());
  if(path.dirname(resolved)!==temporary||!path.basename(resolved).startsWith('varin-native-smoke-'))throw new Error('Fixture root is not a private native smoke session');
  resultFile = path.join(root,`legacy-${mode}.json`);
  app.setName('Varin');
  const profile = path.join(app.getPath('appData'),'Varin');
  if(!samePath(path.resolve(profile),path.resolve(expectedProfile)))throw new Error('Electron native appData differs from the admitted OS profile');
  const marker = path.join(profile,'varin-installer-fixture.json');
  if(mode==='seed'){
    // No recursive creation: an existing directory, even an empty one, is not ours.
    await fs.mkdir(profile,{mode:0o700});
    await fs.writeFile(marker,JSON.stringify({schema:1,product:'varin-legacy-smoke-profile',nonce,electronVersion:process.versions.electron})+'\n',{flag:'wx',mode:0o600});
  }else{
    const stat=await fs.lstat(profile),entry=await fs.lstat(marker);
    if(!stat.isDirectory()||stat.isSymbolicLink()||!entry.isFile()||entry.size>1024)throw new Error('Refusing an unowned source profile');
    const previous=JSON.parse(await fs.readFile(marker,'utf8'));
    if(previous.product!=='varin-legacy-smoke-profile'||previous.nonce!==nonce||previous.electronVersion!==process.versions.electron)throw new Error('Source profile belongs to another invocation or engine');
  }
  app.setPath('userData',profile);app.setPath('sessionData',profile);
  protocol.registerSchemesAsPrivileged([{scheme:'varin-ui',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}]);
  if(!app.requestSingleInstanceLock())throw new Error('Original Electron profile is already in use');
  await app.whenReady();
  await session.defaultSession.protocol.handle('varin-ui',inert);
  session.defaultSession.webRequest.onBeforeRequest((details,callback)=>callback({cancel:!details.url.startsWith('varin-ui://app/')}));
  const ui=await open(session.defaultSession,'varin-ui://app/.frontend-migration.html');
  const keys=['openaiApiKey','openaiCompatibleApiKey','sttApiKey'];
  const config={state:{speechRate:1.25,...Object.fromEntries(keys.map(key=>[key,`fixture-only:${nonce}:config.${key}`]))},version:0};
  await storage(ui,'varin-ui://app',[
    ['varin.editor-workbench.owner',nonce],['config-store',JSON.stringify(config)],
    ...keys.map(key=>[key,`fixture-only:${nonce}:${key}`]),
  ]);
  const browser=session.fromPartition('persist:varin-browser');
  for(const scheme of ['http','https'])await browser.protocol.handle(scheme,inert);
  browser.setPermissionRequestHandler((_w,_p,callback)=>callback(false));
  browser.webRequest.onBeforeRequest((details,callback)=>callback({cancel:details.url!==`${origin}/.varin-migration.html`}));
  const site=await open(browser,`${origin}/.varin-migration.html`);
  await storage(site,origin,[['varin-installer-fixture',nonce]]);
  if(mode==='seed')await browser.cookies.set({url:origin,name:'varin_installer_fixture',value:`fixture-only:${nonce}:cookie`,path:'/',secure:true,httpOnly:true,sameSite:'lax',expirationDate:4000000000});
  const cookies=await browser.cookies.get({url:origin,name:'varin_installer_fixture'});
  if(cookies.length!==1||cookies[0].value!==`fixture-only:${nonce}:cookie`||cookies[0].domain!=='migration-fixture.invalid'||cookies[0].httpOnly!==true||cookies[0].secure!==true||cookies[0].sameSite!=='lax'||cookies[0].session!==false)throw new Error('Synthetic source cookie readback differs');
  session.defaultSession.flushStorageData();browser.flushStorageData();await browser.cookies.flushStore();
  for(const window of windows){window.webContents.debugger.detach();const closed=new Promise(resolve=>window.once('closed',resolve));window.destroy();await closed;}
  await fs.writeFile(resultFile,JSON.stringify({schema:1,product:'varin-legacy-profile-smoke',mode,nonce,electronVersion:process.versions.electron,complete:true,frontendVerified:true,credentialSlotsVerified:6,browserCookieVerified:true,browserLocalStorageVerified:true,valuesDisclosed:false})+'\n',{mode:0o600});
  app.quit();
})().catch(async()=>{
  // No error text, stderr, page content or native database contents are evidence.
  if(resultFile)await fs.writeFile(resultFile,JSON.stringify({schema:1,product:'varin-legacy-profile-smoke',mode,nonce,complete:false,reason:'synthetic-native-profile-operation-failed'})+'\n').catch(()=>{});
  app.exit(1);
});
