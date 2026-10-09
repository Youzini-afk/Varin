//! Read-only native computation. The Storage owner admits sources and retains
//! reader pins; workers never open a writable catalog or mutate workspace files.
mod source;
mod inventory;
mod structure;
mod query;

use crate::protocol_generated::{KernelComputeGrammarParams, KernelComputeStartParams};
use serde_json::{json, Value};
use std::{collections::{HashMap, VecDeque}, fs::File, path::PathBuf,
    sync::{mpsc, Arc, Condvar, Mutex, Weak, atomic::{AtomicBool, Ordering}}, thread::{self, JoinHandle}};

pub(crate) type Result<T> = std::result::Result<T, String>;
const BUFFER_BYTES: usize = 1024 * 1024;
const RECORD_BYTES: usize = crate::protocol::MAX_FRAME_BYTES / 2;

pub(crate) struct ObjectSource {
    pub path: String,
    pub revision: String,
    pub hash: Option<String>,
    pub file: Option<File>,
}
pub(crate) enum Source {
    Tree { catalog: PathBuf, objects: PathBuf, root: String },
    Disk { root: PathBuf },
    Objects,
}
pub(crate) struct Task {
    pub params: KernelComputeStartParams,
    pub source: Source,
    pub overlays: Vec<ObjectSource>,
    pub scopes: Vec<String>,
    pub recipes: HashMap<String, KernelComputeGrammarParams>,
}
struct Buffered { cursor: u64, bytes: usize, record: Value }
struct State {
    status: &'static str,
    records: VecDeque<Buffered>,
    bytes: usize,
    base: u64,
    end: u64,
    scanned: u64,
    message: Option<String>,
    discard: bool,
}
pub(crate) struct Shared {
    state: Mutex<State>,
    space: Condvar,
    pub cancelled: AtomicBool,
    done: AtomicBool,
    watchers: Mutex<Vec<Weak<mpsc::SyncSender<()>>>>,
}
impl Shared {
    fn new() -> Self { Self { state: Mutex::new(State { status: "queued", records: VecDeque::new(),
        bytes: 0, base: 0, end: 0, scanned: 0, message: None, discard: false }),
        space: Condvar::new(), cancelled: AtomicBool::new(false), done: AtomicBool::new(false), watchers: Mutex::new(Vec::new()) } }
    fn notify_watchers(&self) {
        self.watchers.lock().unwrap_or_else(|p| p.into_inner()).retain(|watcher| {
            if let Some(wake) = watcher.upgrade() { let _ = wake.try_send(()); true } else { false }
        });
    }
    pub fn check(&self) -> Result<()> {
        if self.cancelled.load(Ordering::Acquire) { Err("cancelled".into()) } else { Ok(()) }
    }
    pub fn emit(&self, kind: &str, path: &str, revision: &str, data: Value) -> Result<()> {
        self.check()?;
        let record = json!({"kind":kind,"path":path,"revision":revision,"data":data});
        let bytes = serde_json::to_vec(&record).map_err(|e|e.to_string())?.len();
        if bytes > RECORD_BYTES { return Err("Computation record exceeds the bounded protocol frame; request a narrower range".into()); }
        let mut state = self.state.lock().unwrap_or_else(|e|e.into_inner());
        while state.bytes > 0 && state.bytes + bytes > BUFFER_BYTES && !state.discard {
            self.check()?;
            state = self.space.wait(state).unwrap_or_else(|e|e.into_inner());
        }
        self.check()?;
        if !state.discard {
            let cursor = state.end; state.end += 1; state.bytes += bytes;
            state.records.push_back(Buffered {cursor,bytes,record});
            self.notify_watchers();
        }
        Ok(())
    }
    pub fn scanned(&self) { self.state.lock().unwrap_or_else(|e|e.into_inner()).scanned += 1; }
    fn running(&self) { self.state.lock().unwrap_or_else(|e|e.into_inner()).status = "running"; }
    fn finish(&self, result: Result<bool>) {
        let mut state = self.state.lock().unwrap_or_else(|e|e.into_inner());
        if self.cancelled.load(Ordering::Acquire) { state.status="cancelled"; state.message=Some("Native computation cancelled".into()); }
        else { match result {
            Ok(partial) => state.status = if partial {"partial"} else if state.end==0 {"empty"} else {"ready"},
            Err(message) => { state.status=if state.end==0 {"failed"} else {"partial"}; state.message=Some(message); }
        } }
        self.done.store(true,Ordering::Release); self.space.notify_all();
        self.notify_watchers();
    }
    fn cancel(&self) {
        self.cancelled.store(true,Ordering::Release);
        let mut state=self.state.lock().unwrap_or_else(|e|e.into_inner());
        state.discard=true; state.records.clear(); state.bytes=0; state.base=state.end;
        self.space.notify_all();
    }
}
struct Work { id:String, shared:Arc<Shared>, task:Task }
#[derive(Default)]
struct Queue { work:Mutex<VecDeque<Work>>, available:Condvar, closed:AtomicBool }
impl Queue {
    fn push(&self,work:Work) { self.work.lock().unwrap_or_else(|e|e.into_inner()).push_back(work); self.available.notify_one(); }
    fn remove(&self,id:&str) {
        let mut queue=self.work.lock().unwrap_or_else(|e|e.into_inner());
        if let Some(index)=queue.iter().position(|w|w.id==id) {
            let work=queue.remove(index).unwrap(); work.shared.finish(Err("cancelled".into()));
        }
    }
    fn close(&self) {
        // Publish closure under the wait predicate's mutex, so rollback/shutdown cannot lose a wake.
        let _queue = self.work.lock().unwrap_or_else(|e| e.into_inner());
        self.closed.store(true, Ordering::Release);
        self.available.notify_all();
    }
    fn take(&self)->Option<Work> {
        let mut queue=self.work.lock().unwrap_or_else(|e|e.into_inner());
        loop { if let Some(work)=queue.pop_front(){return Some(work);}
            if self.closed.load(Ordering::Acquire){return None;}
            queue=self.available.wait(queue).unwrap_or_else(|e|e.into_inner());
        }
    }
}
pub(crate) struct Job {
    pub grant_id:String,
    pub workspace_id:String,
    pub epoch:String,
    pub pin_id:Option<String>,
    pub root:Option<String>,
    pub params_hash:String,
    pub revoked:bool,
    shared:Arc<Shared>,
}
impl Job {
    pub fn done(&self)->bool {self.shared.done.load(Ordering::Acquire)}
    pub fn watch(&self) -> ComputeWatch { ComputeWatch(self.shared.clone()) }
}
/// A read-only notification handle to the admitted job, not another job registry.
/// It remains valid through revocation/removal and identifies this exact execution.
pub(crate) struct ComputeWatch(Arc<Shared>);
impl ComputeWatch {
    pub fn wait(&self, cursor: u64, terminal_only: bool, cancel: &varin_runtime::execution::CancellationToken) -> bool {
        let (wake, events) = mpsc::sync_channel(1);
        let wake = Arc::new(wake);
        let _cancellation = cancel.wake_on_cancel((*wake).clone());
        {
            let mut watchers = self.0.watchers.lock().unwrap_or_else(|p| p.into_inner());
            watchers.retain(|watcher| watcher.strong_count() > 0);
            watchers.push(Arc::downgrade(&wake));
        }
        loop {
            // Register before checking the authoritative predicate; notifications
            // coalesce but neither completion nor cancellation can be missed.
            if cancel.is_cancelled() { return false; }
            {
                let state = self.0.state.lock().unwrap_or_else(|p| p.into_inner());
                if self.0.done.load(Ordering::Acquire) || (!terminal_only && state.end > cursor) {
                    return true;
                }
            }
            // No Storage, catalog, queue or job-state lock is held while waiting.
            if events.recv().is_err() { return false; }
        }
    }
}
#[derive(Default)]
pub(crate) struct ComputeManager {
    pub jobs:HashMap<String,Job>,
    pub recipes:HashMap<String,KernelComputeGrammarParams>,
    foreground:Arc<Queue>, background:Arc<Queue>,
    workers:Vec<JoinHandle<()>>,
}
impl ComputeManager {
    fn ensure_workers(&mut self) -> Result<()> {
        if !self.workers.is_empty(){return Ok(());}
        // The actual workers and native admission use the same deployment budget. Background
        // work keeps its independent lane; model/service waits never consume these workers.
        let capacity = varin_runtime::execution_capacity::configured_compute_capacity()?;
        let foreground = self.foreground.clone();
        let queues = (0..capacity.get()).map(move |index| (format!("compute-read-{index}"), foreground.clone()))
            .chain(std::iter::once(("compute-index".into(), self.background.clone())));
        for (name, queue) in queues {
            let worker=thread::Builder::new().name(name.into()).spawn(move||{
                let mut syntax=structure::SyntaxRuntime::default();
                while let Some(work)=queue.take() {
                    work.shared.running();
                    let result=std::panic::catch_unwind(std::panic::AssertUnwindSafe(||query::execute(work.task,&work.shared,&mut syntax)))
                        .unwrap_or_else(|_|Err("Native computation failed unexpectedly".into()));
                    work.shared.finish(result);
                }
            });
            match worker {
                Ok(worker) => self.workers.push(worker),
                Err(error) => {
                    // No task has been queued yet. A partial pool must not masquerade as the
                    // configured capacity on the next start after an OS thread-creation failure.
                    self.foreground.close(); self.background.close();
                    for worker in self.workers.drain(..) { let _ = worker.join(); }
                    self.foreground = Arc::default(); self.background = Arc::default();
                    return Err(error.to_string());
                }
            }
        }
        Ok(())
    }
    pub fn start(&mut self,id:String,task:Task,grant_id:String,epoch:String,pin_id:Option<String>,root:Option<String>,params_hash:String)->Result<()> {
        self.ensure_workers()?;
        let shared=Arc::new(Shared::new());
        let background=task.params.lane=="background";
        self.jobs.insert(id.clone(),Job {grant_id,workspace_id:task.params.workspace_id.clone(),epoch,pin_id,root,params_hash,revoked:false,shared:shared.clone()});
        let work=Work{id,task,shared};
        if background{self.background.push(work);}else{self.foreground.push(work);}
        Ok(())
    }
    pub fn read(&self,id:&str,cursor:u64,max_bytes:usize)->Result<Value> {
        let job=self.jobs.get(id).ok_or("Computation handle is unavailable")?;
        let mut state=job.shared.state.lock().unwrap_or_else(|e|e.into_inner());
        // Cancellation deliberately discards buffered output; a caller still
        // observes the task's real terminal state before releasing reader pins.
        let cursor=if state.discard{state.end}else{cursor};
        if cursor<state.base||cursor>state.end{return Err("Computation cursor is expired or beyond produced output".into());}
        while state.records.front().is_some_and(|r|r.cursor<cursor) {
            if let Some(record)=state.records.pop_front(){state.bytes-=record.bytes;}
        }
        state.base=cursor;job.shared.space.notify_all();
        let mut records=Vec::new();let mut bytes=0;let mut next=cursor;
        for record in &state.records {
            if !records.is_empty()&&bytes+record.bytes>max_bytes{break;}
            records.push(record.record.clone());bytes+=record.bytes;next=record.cursor+1;
        }
        Ok(json!({"jobId":id,"kernelEpoch":job.epoch,"workspaceId":job.workspace_id,"status":state.status,
            "root":job.root,"records":records,"nextCursor":next,"endCursor":state.end,"scannedFiles":state.scanned,"message":state.message}))
    }
    pub fn cancel(&self,id:&str) {
        if let Some(job)=self.jobs.get(id){job.shared.cancel();self.foreground.remove(id);self.background.remove(id);}
    }
    pub fn revoke(&mut self,grant_id:&str) {
        let ids=self.jobs.iter_mut().filter_map(|(id,job)|if job.grant_id==grant_id{job.revoked=true;Some(id.clone())}else{None}).collect::<Vec<_>>();
        for id in ids{self.cancel(&id);}
    }
    pub fn shutdown(&mut self) {
        let ids=self.jobs.keys().cloned().collect::<Vec<_>>();for id in ids{self.cancel(&id);}
        self.foreground.close(); self.background.close();
        for worker in self.workers.drain(..){let _=worker.join();}
    }
}
impl Drop for ComputeManager {fn drop(&mut self){self.shutdown();}}
