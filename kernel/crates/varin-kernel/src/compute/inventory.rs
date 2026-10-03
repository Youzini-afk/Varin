//! Git determines tracked/ignored membership; traversal and bytes remain native.
//! This is a fixed read-only Git command, not a generic process escape hatch.
use super::{Result, Shared};
use std::{collections::HashSet, io::Read, path::Path, process::{Command, Stdio}, thread, time::Duration};

pub(super) struct GitInventory {
    files: HashSet<String>, directories: HashSet<String>,
    pub git_root: String,
    pub selected_root_ignored: Option<bool>,
}
impl GitInventory {
    pub fn allows(&self, path: &str, directory: bool) -> bool {
        if directory { path.is_empty() || self.directories.contains(path) } else { self.files.contains(path) }
    }
}
fn read(mut stream: impl Read) -> std::io::Result<Vec<u8>> {
    let mut bytes=Vec::new(); stream.read_to_end(&mut bytes)?; Ok(bytes)
}
fn run_git(root: &Path, args: &[&str], shared: &Shared) -> Result<(std::process::ExitStatus, Vec<u8>, Vec<u8>)> {
    shared.check()?;
    let mut command=Command::new("git");
    command.args(args)
        .current_dir(root).env("LC_ALL","C").env("GIT_OPTIONAL_LOCKS","0")
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
    let mut child=command.spawn().map_err(|e|format!("Git inventory is unavailable: {e}"))?;
    let stdout=child.stdout.take().ok_or("Git inventory stdout unavailable")?;
    let stderr=child.stderr.take().ok_or("Git inventory stderr unavailable")?;
    let output=thread::spawn(move||read(stdout));
    let diagnostic=thread::spawn(move||read(stderr));
    let status=loop {
        if shared.check().is_err() { let _=child.kill(); let _=child.wait(); break Err("cancelled".into()); }
        match child.try_wait() {
            Ok(Some(status))=>break Ok(status),
            Ok(None)=>thread::sleep(Duration::from_millis(10)),
            Err(error)=>{let _=child.kill();let _=child.wait();break Err(error.to_string());}
        }
    };
    let output=output.join().map_err(|_|"Git inventory reader failed")?.map_err(|e|e.to_string())?;
    let diagnostic=diagnostic.join().map_err(|_|"Git inventory diagnostic reader failed")?.map_err(|e|e.to_string())?;
    Ok((status?, output, diagnostic))
}

pub(super) fn git_inventory(root: &Path, shared: &Shared, paths: Option<&[String]>) -> Result<Option<GitInventory>> {
    let (status, git_root, diagnostic) = run_git(root, &["rev-parse", "--show-toplevel"], shared)?;
    if !status.success() {
        if status.code()==Some(128)&&String::from_utf8_lossy(&diagnostic).contains("not a git repository") {return Ok(None);}
        return Err(format!("Git inventory failed (exit {:?}); enumeration is incomplete",status.code()));
    }
    let git_root = std::str::from_utf8(&git_root).map_err(|_| "Git root is not UTF-8")?
        .trim_end_matches(['\r', '\n']).to_string();
    // Exact-file eligibility must not enumerate every sibling in its Git tree.
    // Literal pathspecs also keep wildcard characters in user filenames literal.
    let mut args = vec!["--literal-pathspecs", "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--"];
    if let Some(paths) = paths { args.extend(paths.iter().map(String::as_str)); } else { args.push("."); }
    let (status, output, _) = run_git(root, &args, shared)?;
    if !status.success() { return Err(format!("Git inventory failed (exit {:?}); enumeration is incomplete", status.code())); }
    let mut files=HashSet::new();let mut directories=HashSet::new();
    for bytes in output.split(|b|*b==0).filter(|b|!b.is_empty()) {
        shared.check()?;
        let path=std::str::from_utf8(bytes).map_err(|_|"Git inventory contains a non-UTF8 path")?.to_string();
        let mut parent=path.as_str();
        while let Some((next,_))=parent.rsplit_once('/') { directories.insert(next.to_string());parent=next; }
        files.insert(path);
    }
    let selected_root_ignored = if files.is_empty() {
        let (status, _, _) = run_git(root, &["check-ignore", "--quiet", "--", "."], shared)?;
        match status.code() {
            Some(0) => Some(true), Some(1) => Some(false),
            _ => return Err("Git could not determine the selected directory's ignore status".into()),
        }
    } else { None };
    Ok(Some(GitInventory{files,directories,git_root,selected_root_ignored}))
}
