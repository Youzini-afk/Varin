//! Select once at admission; a failed accepted mount never changes backends or
//! sources. FSKit is our bundled path-resource executor, macFUSE uses VFS.
use super::*;
use std::os::unix::fs::MetadataExt;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool,Ordering};
use serde_json::{json,Value};

pub(crate) fn helper() -> Result<PathBuf,KernelError> {
    Ok(std::env::current_exe()?.parent().ok_or_else(||unsupported("Kernel directory is missing"))?
        .join("VarinWorkspace.app/Contents/MacOS/VarinWorkspace"))
}
pub(crate) fn facts() -> Value {
    match helper().and_then(|helper| {
        if !helper.is_file() {return Ok(json!({"ready":false,"reason":"helper_not_packaged","detail":"This Host does not include the built-in FSKit executor"}));}
        let output=std::process::Command::new(helper).arg("--inspect").output()?;
        if !output.status.success(){return Err(unsupported("The built-in filesystem helper failed inspection"));}
        Ok(serde_json::from_slice::<Value>(&output.stdout)?)
    }) {Ok(value)=>value,Err(error)=>json!({"ready":false,"reason":"extension_inspection_failed","detail":error.to_string()})}
}
pub(crate) fn select() -> Result<&'static str,KernelError> {
    let own=facts();
    if own["ready"]==true {return Ok("fskit");}
    match fuser::mount_dependencies() {
        Ok(())=>Ok("macfuse"),
        Err(error)=>Err(crate::workspace_backend::unavailable(own["reason"].as_str().unwrap_or("dependency_unavailable"),
            format!("{}. An installed macFUSE VFS backend is also unavailable: {error}",own["detail"].as_str().unwrap_or("Built-in FSKit is unavailable")))),
    }
}
pub(crate) enum Mount { FSKit(NativeMount), MacFUSE(super::fuse::Mount) }
impl Mount {
    pub(crate) fn start(session:Arc<Session>,target:&Path)->Result<Self,KernelError>{
        match select()? {"fskit"=>NativeMount::start(session,target).map(Self::FSKit),_=>super::fuse::Mount::start(session,target).map(Self::MacFUSE)}
    }
    pub(crate) fn wait_ready_cancelled(&self,cancelled:&AtomicBool)->Result<(),KernelError>{match self {Self::FSKit(m)=>m.wait_ready(cancelled),Self::MacFUSE(m)=>m.wait_ready_cancelled(cancelled)}}
    #[cfg(test)]
    pub(crate) fn wait_ready(&self)->Result<(),KernelError>{self.wait_ready_cancelled(&AtomicBool::new(false))}
    pub(crate) fn checkpoint_at(&self,selected:&str)->Result<crate::storage::workspace_session::Checkpoint,KernelError>{match self{Self::FSKit(m)=>m.checkpoint(selected),Self::MacFUSE(m)=>m.checkpoint_at(selected)}}
    #[cfg(test)]
    pub(crate) fn checkpoint(&self)->Result<crate::storage::workspace_session::Checkpoint,KernelError>{self.checkpoint_at("")}
    pub(crate) fn capabilities(&self)->Value{match self{Self::FSKit(_)=>json!({"backend":"fskit","transport":"path_resource","cacheFence":"darwin_volume_wait","activeWritableMappingFork":true}),Self::MacFUSE(m)=>m.capabilities()}}
    pub(crate) fn stop(&mut self)->Result<(),KernelError>{match self{Self::FSKit(m)=>m.stop(),Self::MacFUSE(m)=>m.stop()}}
}
pub(crate) struct NativeMount {
    server:super::native_service::Server,
    session:Arc<Session>,target:PathBuf,device:u64,
    mounting:Mutex<std::process::Child>,log:PathBuf,
}
impl NativeMount {
    fn start(session:Arc<Session>,target:&Path)->Result<Self,KernelError>{
        admit_target(target)?;
        let device=std::fs::metadata(target)?.dev();
        let server=super::native_service::Server::start(session.clone())?;
        let log=server.resource.join("mount.log");
        let output=std::fs::OpenOptions::new().create_new(true).write(true).open(&log)?;
        session.mount_started();
        let mounting=std::process::Command::new("/sbin/mount").args(["-F","-t","varin","-o","nosuid,nodev"])
            .arg(&server.resource).arg(target).stdout(output.try_clone()?).stderr(output).spawn()?;
        Ok(Self{server,session,target:target.into(),device,mounting:Mutex::new(mounting),log})
    }
    fn wait_ready(&self,cancelled:&AtomicBool)->Result<(),KernelError>{
        loop {
            if cancelled.load(Ordering::Acquire){return Err(KernelError::Cancelled);}
            self.session.check_open()?;
            let status=self.mounting.lock().map_err(|_|unsupported("FSKit launcher state failed"))?.try_wait()?;
            if let Some(status)=status {if !status.success(){return Err(KernelError::Execution(varin_runtime::execution::ExecutionError::new("workspace_mount_failed",
                format!("FSKit mount failed: {}",std::fs::read_to_string(&self.log).unwrap_or_else(|_|status.to_string()))).with_details(json!({"backend":"fskit","stage":"workspace_mount"}))));}}
            if self.server.attached.load(Ordering::Acquire) && std::fs::metadata(&self.target).is_ok_and(|m|m.dev()!=self.device){return Ok(());}
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    }
    fn checkpoint(&self,selected:&str)->Result<crate::storage::workspace_session::Checkpoint,KernelError>{
        super::darwin_cache_fence(&self.target)?;
        self.session.checkpoint_native(selected,&[],&[])
    }
    fn stop(&mut self)->Result<(),KernelError>{
        {let mut child=self.mounting.lock().map_err(|_|unsupported("FSKit launcher state failed"))?;
         if child.try_wait()?.is_none(){child.kill()?;child.wait()?;}}
        let mounted=std::fs::metadata(&self.target).is_ok_and(|m|m.dev()!=self.device);
        if mounted {
            let opens=self.server.open_count()?;
            if opens!=0{return Err(KernelError::Execution(varin_runtime::execution::ExecutionError::new("workspace_native_handles_active",format!("Waiting for {opens} original FSKit references to close"))));}
            self.server.stopping(true);
            let output=std::process::Command::new("/sbin/umount").arg(&self.target).output()?;
            if !output.status.success(){self.server.stopping(false);return Err(KernelError::Storage(format!("FSKit detach failed: {}",String::from_utf8_lossy(&output.stderr))));}
            if std::fs::metadata(&self.target)?.dev()!=self.device {self.server.stopping(false);return Err(unsupported("FSKit detach was not confirmed"));}
        }
        self.server.stop();self.session.close()
    }
}
