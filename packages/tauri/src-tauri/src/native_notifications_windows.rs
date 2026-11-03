//! Win32 toast presentation and COM activation, including Action Center after
//! the banner times out. Uses the same unpackaged app identity as Electron.
//! Reference contracts: Microsoft DesktopToasts sample and the Windows
//! Community Toolkit ToastNotificationManagerCompat registration strategy.
use super::windows_policy as policy;
use std::{
    collections::{HashMap, HashSet},
    ffi::c_void,
    path::{Path, PathBuf},
    sync::{Arc, mpsc},
    thread::{self, JoinHandle},
};
use windows::{
    Data::Xml::Dom::XmlDocument,
    Foundation::TypedEventHandler,
    UI::Notifications::{
        ToastDismissedEventArgs, ToastFailedEventArgs, ToastNotification, ToastNotificationManager,
        ToastNotifier,
    },
    Win32::{
        Foundation::{CLASS_E_NOAGGREGATION, E_POINTER},
        System::{
            Com::{
                CLSCTX_LOCAL_SERVER, CoRegisterClassObject, CoRevokeClassObject, IClassFactory,
                IClassFactory_Impl, REGCLS_MULTIPLEUSE,
            },
            Registry::{
                HKEY, HKEY_CURRENT_USER, KEY_SET_VALUE, REG_OPTION_NON_VOLATILE, REG_SZ,
                RegCloseKey, RegCreateKeyExW, RegSetValueExW,
            },
            WinRT::{RO_INIT_MULTITHREADED, RoInitialize, RoUninitialize},
        },
        UI::{
            Notifications::{
                INotificationActivationCallback, INotificationActivationCallback_Impl,
                NOTIFICATION_USER_INPUT_DATA,
            },
            Shell::SetCurrentProcessExplicitAppUserModelID,
        },
    },
    core::{
        BOOL, GUID, HSTRING, IInspectable, IUnknown, Interface, PCWSTR, Ref, Result, implement,
    },
};

type Callback = Arc<dyn Fn(&str) + Send + Sync>;

pub struct Owner {
    commands: mpsc::Sender<Command>,
    worker: Option<JoinHandle<()>>,
}

enum Command {
    Show {
        token: String,
        title: String,
        body: String,
    },
    Activated(String),
    Dismissed {
        token: String,
        reason: i32,
    },
    Failed(String),
    Stop,
}

impl Owner {
    pub fn start(
        development: bool,
        executable: PathBuf,
        icon: PathBuf,
        activate: impl Fn(&str) + Send + Sync + 'static,
        release: impl Fn(&str) + Send + Sync + 'static,
    ) -> std::result::Result<Self, String> {
        let (commands, receiver) = mpsc::channel();
        let (ready, initialized) = mpsc::sync_channel(1);
        let sender = commands.clone();
        let worker = thread::Builder::new()
            .name("varin-windows-notifications".into())
            .spawn(move || {
                let runtime = Runtime::new(development, &executable, &icon, sender);
                match runtime {
                    Ok(mut runtime) => {
                        if ready.send(Ok(())).is_ok() {
                            runtime.run(receiver, Arc::new(activate), Arc::new(release));
                        }
                    }
                    Err(error) => {
                        let _ = ready.send(Err(format!(
                            "Windows notification registration failed (0x{:08X})",
                            error.code().0 as u32
                        )));
                    }
                }
            })
            .map_err(|_| "Windows notification owner could not start")?;
        match initialized.recv() {
            Ok(Ok(())) => Ok(Self {
                commands,
                worker: Some(worker),
            }),
            result => {
                let _ = worker.join();
                Err(result
                    .unwrap_or_else(|_| {
                        Err("Windows notification owner exited during startup".into())
                    })
                    .unwrap_err())
            }
        }
    }

    pub fn show(&self, token: &str, title: &str, body: &str) -> std::result::Result<(), String> {
        if !policy::valid_token(token) {
            return Err("Invalid native notification token".into());
        }
        self.commands
            .send(Command::Show {
                token: token.into(),
                title: title.into(),
                body: body.into(),
            })
            .map_err(|_| "Windows notifications are shutting down".into())
    }

    pub fn shutdown(&mut self) {
        let _ = self.commands.send(Command::Stop);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
impl Drop for Owner {
    fn drop(&mut self) {
        self.shutdown();
    }
}

struct Apartment;
impl Apartment {
    fn new() -> Result<Self> {
        unsafe {
            RoInitialize(RO_INIT_MULTITHREADED)?;
        }
        Ok(Self)
    }
}
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe {
            RoUninitialize();
        }
    }
}

struct Registration(u32);
impl Drop for Registration {
    fn drop(&mut self) {
        unsafe {
            let _ = CoRevokeClassObject(self.0);
        }
    }
}

struct Runtime {
    // Fields drop in declaration order: release the notifier/COM class before
    // balancing RoInitialize on the same dedicated MTA thread.
    notifier: ToastNotifier,
    _registration: Registration,
    _apartment: Apartment,
    app_id: String,
    commands: mpsc::Sender<Command>,
}
impl Runtime {
    fn new(
        development: bool,
        executable: &Path,
        icon: &Path,
        commands: mpsc::Sender<Command>,
    ) -> Result<Self> {
        let apartment = Apartment::new()?;
        let (app_id, clsid_text) = if development {
            (policy::DEV_APP_ID, policy::DEV_ACTIVATOR_CLSID)
        } else {
            (policy::APP_ID, policy::ACTIVATOR_CLSID)
        };
        register_current_user(app_id, clsid_text, executable, icon)?;
        unsafe {
            SetCurrentProcessExplicitAppUserModelID(PCWSTR(HSTRING::from(app_id).as_ptr()))?;
        }
        let clsid = GUID::try_from(clsid_text)?;
        let factory: IClassFactory = ActivatorFactory {
            app_id: app_id.into(),
            commands: commands.clone(),
        }
        .into();
        let registration = Registration(unsafe {
            CoRegisterClassObject(&clsid, &factory, CLSCTX_LOCAL_SERVER, REGCLS_MULTIPLEUSE)?
        });
        let notifier = ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(app_id))?;
        Ok(Self {
            notifier,
            _registration: registration,
            _apartment: apartment,
            app_id: app_id.into(),
            commands,
        })
    }

    fn run(&mut self, receiver: mpsc::Receiver<Command>, activate: Callback, release: Callback) {
        let mut toasts: HashMap<String, LiveToast> = HashMap::new();
        // Blocking channel receive, not a timer. COM delivers callbacks on MTA
        // RPC threads; no GUI message pump and no idle polling are necessary.
        while let Ok(command) = receiver.recv() {
            match command {
                Command::Show { token, title, body } => {
                    self.reconcile_history(&mut toasts, &release);
                    match self.present(&token, &title, &body) {
                        Ok(toast) => {
                            toasts.insert(token, toast);
                        }
                        Err(_) => release(&token),
                    }
                }
                Command::Activated(token) => {
                    // Both the onscreen Activated event and the COM activator
                    // can arrive. Removal of the opaque token makes it one-shot.
                    if toasts.remove(&token).is_some() {
                        activate(&token);
                    }
                    // A cold restart has no trusted in-memory route. It already
                    // opens Varin normally; never reconstruct one from OS input.
                }
                Command::Dismissed { token, reason } => {
                    if policy::keep_after_dismissal(reason) {
                        if let Some(toast) = toasts.get_mut(&token) {
                            toast.banner_visible = false;
                        }
                    } else if toasts.remove(&token).is_some() {
                        release(&token);
                    }
                }
                Command::Failed(token) => {
                    if toasts.remove(&token).is_some() {
                        release(&token);
                    }
                }
                Command::Stop => break,
            }
        }
        // Disconnect native callbacks before the COM class and apartment are
        // released. There is no self-retaining callback/Toast reference cycle.
        for (token, _) in toasts.drain() {
            release(&token);
        }
    }

    fn present(&self, token: &str, title: &str, body: &str) -> Result<LiveToast> {
        let xml = policy::toast_xml(token, title, body).ok_or_else(|| {
            windows::core::Error::from_hresult(windows::Win32::Foundation::E_INVALIDARG)
        })?;
        let document = XmlDocument::new()?;
        document.LoadXml(&HSTRING::from(xml))?;
        let toast = ToastNotification::CreateToastNotification(&document)?;
        toast.SetTag(&HSTRING::from(token))?;
        toast.SetGroup(&HSTRING::from(policy::TOAST_GROUP))?;
        let mut live = LiveToast {
            toast,
            activated: None,
            dismissed: None,
            failed: None,
            banner_visible: true,
            history_seen: false,
        };
        let commands = self.commands.clone();
        let key = token.to_owned();
        live.activated = Some(live.toast.Activated(&TypedEventHandler::<
            ToastNotification,
            IInspectable,
        >::new(move |_, _| {
            let _ = commands.send(Command::Activated(key.clone()));
            Ok(())
        }))?);
        let commands = self.commands.clone();
        let key = token.to_owned();
        live.dismissed = Some(live.toast.Dismissed(&TypedEventHandler::<
            ToastNotification,
            ToastDismissedEventArgs,
        >::new(move |_, arguments| {
            if let Some(arguments) = arguments.as_ref() {
                let _ = commands.send(Command::Dismissed {
                    token: key.clone(),
                    reason: arguments.Reason()?.0,
                });
            }
            Ok(())
        }))?);
        let commands = self.commands.clone();
        let key = token.to_owned();
        live.failed = Some(live.toast.Failed(&TypedEventHandler::<
            ToastNotification,
            ToastFailedEventArgs,
        >::new(move |_, _| {
            let _ = commands.send(Command::Failed(key.clone()));
            Ok(())
        }))?);
        self.notifier.Show(&live.toast)?;
        Ok(live)
    }

    fn reconcile_history(&self, toasts: &mut HashMap<String, LiveToast>, release: &Callback) {
        let history = ToastNotificationManager::History()
            .and_then(|history| history.GetHistoryWithId(&HSTRING::from(&self.app_id)));
        let Ok(history) = history else {
            return;
        };
        let mut active = HashSet::new();
        let Ok(count) = history.Size() else {
            return;
        };
        for index in 0..count {
            let Ok(toast) = history.GetAt(index) else {
                return;
            };
            let Ok(group) = toast.Group() else {
                return;
            };
            if group == policy::TOAST_GROUP {
                let Ok(tag) = toast.Tag() else {
                    return;
                };
                active.insert(tag.to_string_lossy());
            }
        }
        // Windows does not notify unpackaged apps when history is cleared after
        // their banner callback ended. Reconcile on real activity only. Banners
        // still onscreen are retained because history insertion is asynchronous.
        toasts.retain(|token, toast| {
            if active.contains(token) {
                toast.history_seen = true;
                true
            } else if toast.banner_visible && !toast.history_seen {
                true
            } else {
                release(token);
                false
            }
        });
    }
}

struct LiveToast {
    toast: ToastNotification,
    activated: Option<i64>,
    dismissed: Option<i64>,
    failed: Option<i64>,
    banner_visible: bool,
    history_seen: bool,
}
impl Drop for LiveToast {
    fn drop(&mut self) {
        if let Some(token) = self.activated.take() {
            let _ = self.toast.RemoveActivated(token);
        }
        if let Some(token) = self.dismissed.take() {
            let _ = self.toast.RemoveDismissed(token);
        }
        if let Some(token) = self.failed.take() {
            let _ = self.toast.RemoveFailed(token);
        }
    }
}

#[implement(INotificationActivationCallback)]
struct Activator {
    app_id: String,
    commands: mpsc::Sender<Command>,
}
impl INotificationActivationCallback_Impl for Activator_Impl {
    fn Activate(
        &self,
        appusermodelid: &PCWSTR,
        invokedargs: &PCWSTR,
        _data: *const NOTIFICATION_USER_INPUT_DATA,
        _count: u32,
    ) -> Result<()> {
        // These are COM marshalled, NUL-terminated strings, not an arbitrary
        // renderer pointer. Limit reads to the only accepted wire contract.
        let app_id = unsafe { bounded_string(*appusermodelid, 64) };
        let arguments = unsafe { bounded_string(*invokedargs, 64) };
        if app_id.as_deref() == Some(self.app_id.as_str()) {
            if let Some(token) = arguments.as_deref().and_then(policy::activation_token) {
                let _ = self.commands.send(Command::Activated(token.into()));
            }
        }
        Ok(())
    }
}

#[implement(IClassFactory)]
struct ActivatorFactory {
    app_id: String,
    commands: mpsc::Sender<Command>,
}
impl IClassFactory_Impl for ActivatorFactory_Impl {
    fn CreateInstance(
        &self,
        outer: Ref<'_, IUnknown>,
        iid: *const GUID,
        result: *mut *mut c_void,
    ) -> Result<()> {
        if iid.is_null() || result.is_null() {
            return Err(E_POINTER.into());
        }
        unsafe {
            *result = std::ptr::null_mut();
        }
        if !outer.is_null() {
            return Err(CLASS_E_NOAGGREGATION.into());
        }
        let activator: INotificationActivationCallback = Activator {
            app_id: self.app_id.clone(),
            commands: self.commands.clone(),
        }
        .into();
        unsafe { activator.query(iid, result).ok() }
    }
    fn LockServer(&self, _lock: BOOL) -> Result<()> {
        Ok(())
    }
}

unsafe fn bounded_string(value: PCWSTR, maximum: usize) -> Option<String> {
    if value.is_null() {
        return None;
    }
    for count in 0..=maximum {
        if unsafe { *value.0.add(count) } == 0 {
            return String::from_utf16(unsafe { std::slice::from_raw_parts(value.0, count) }).ok();
        }
    }
    None
}

fn register_current_user(app_id: &str, clsid: &str, executable: &Path, icon: &Path) -> Result<()> {
    let executable = executable.to_string_lossy();
    let command = format!("\"{executable}\" {}", policy::ACTIVATION_FLAG);
    let class = format!("Software\\Classes\\CLSID\\{{{clsid}}}\\LocalServer32");
    let app = format!("Software\\Classes\\AppUserModelId\\{app_id}");
    registry_string(&class, "", &command)?;
    registry_string(&app, "CustomActivator", &format!("{{{clsid}}}"))?;
    registry_string(
        &app,
        "DisplayName",
        if app_id == policy::DEV_APP_ID {
            "Varin Dev"
        } else {
            "Varin"
        },
    )?;
    registry_string(&app, "IconUri", &icon.to_string_lossy())?;
    registry_string(&app, "VarinNotificationOwner", &executable)
}

fn registry_string(path: &str, name: &str, value: &str) -> Result<()> {
    let path = HSTRING::from(path);
    let name = HSTRING::from(name);
    let data: Vec<u8> = value
        .encode_utf16()
        .chain(Some(0))
        .flat_map(u16::to_le_bytes)
        .collect();
    let mut key = HKEY::default();
    unsafe {
        RegCreateKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR(path.as_ptr()),
            None,
            PCWSTR::null(),
            REG_OPTION_NON_VOLATILE,
            KEY_SET_VALUE,
            None,
            &mut key,
            None,
        )
        .ok()?;
        let result = RegSetValueExW(key, PCWSTR(name.as_ptr()), None, REG_SZ, Some(&data)).ok();
        let _ = RegCloseKey(key);
        result
    }
}
