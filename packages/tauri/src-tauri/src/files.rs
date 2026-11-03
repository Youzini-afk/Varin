//! Native file read boundary for the existing desktop import command. Resolve
//! aliases before applying the home/temp scope and secret-store exclusions.
use std::{fs::File,io::Read,path::{Path,PathBuf}};
const LIMIT:u64=50*1024*1024;
pub fn approved_path(path:&Path,home:&Path,temp:&Path)->Result<PathBuf,String>{
    let path=path.canonicalize().map_err(|_|"File is unavailable")?;
    let home=home.canonicalize().map_err(|_|"Home directory is unavailable")?;
    let temp=temp.canonicalize().map_err(|_|"Temporary directory is unavailable")?;
    if !path.starts_with(&home)&&!path.starts_with(&temp){return Err("File is outside the allowed workspace".into())}
    let parts:Vec<_>=path.components().map(|part|part.as_os_str().to_string_lossy().to_lowercase()).collect();
    if parts.iter().any(|part|matches!(part.as_str(),".ssh"|".aws"|".gnupg"|".gpg"|"keychains"|"login data"|"cookies") || part==".env"||part.starts_with(".env.")||part.ends_with(".pem")||part.ends_with(".key"))
        || parts.windows(2).any(|p|p[0]==".config"&&p[1]=="gh"||p[0]=="varin"&&p[1]=="credentials"){
        return Err("Access to this path is not allowed".into())
    }
    Ok(path)
}
pub fn read(path:&Path,home:&Path,temp:&Path)->Result<(Vec<u8>,String),String>{
    let path=approved_path(path,home,temp)?;
    let mut file=File::open(&path).map_err(|_|"File could not be opened")?;
    let metadata=file.metadata().map_err(|_|"File could not be inspected")?;
    if !metadata.is_file()||metadata.len()>LIMIT{return Err("File must be a regular file no larger than 50MB".into())}
    let mut bytes=Vec::with_capacity(metadata.len() as usize);
    file.by_ref().take(LIMIT+1).read_to_end(&mut bytes).map_err(|_|"File could not be read")?;
    if bytes.len()as u64>LIMIT{return Err("File grew beyond the 50MB limit".into())}
    let extension=path.extension().and_then(|s|s.to_str()).unwrap_or("").to_ascii_lowercase();
    let mime=match extension.as_str(){"png"=>"image/png","jpg"|"jpeg"=>"image/jpeg","gif"=>"image/gif","webp"=>"image/webp","svg"=>"image/svg+xml","bmp"=>"image/bmp","ico"=>"image/x-icon","pdf"=>"application/pdf","txt"=>"text/plain","md"=>"text/markdown","json"=>"application/json","js"=>"text/javascript","ts"=>"text/typescript","tsx"=>"text/typescript-jsx","jsx"=>"text/javascript-jsx","html"=>"text/html","css"=>"text/css","py"=>"text/x-python",_=>"application/octet-stream"};
    Ok((bytes,mime.into()))
}
#[cfg(test)]mod tests{
    use super::*;
    #[test]fn reads_only_regular_non_secret_workspace_files(){
        let root=tempfile::tempdir().unwrap();let home=root.path().join("home");let temp=root.path().join("tmp");std::fs::create_dir_all(&home).unwrap();std::fs::create_dir_all(&temp).unwrap();
        let safe=home.join("notes.md");std::fs::write(&safe,"content").unwrap();assert_eq!(read(&safe,&home,&temp).unwrap(),(b"content".to_vec(),"text/markdown".into()));
        let secret=home.join(".env");std::fs::write(&secret,"not-read").unwrap();assert!(read(&secret,&home,&temp).is_err());assert!(read(&home,&home,&temp).is_err());
        let outside=root.path().join("outside");std::fs::write(&outside,"outside").unwrap();assert!(read(&outside,&home,&temp).is_err());
    }
    #[test]#[cfg(unix)]fn symlink_alias_does_not_bypass_scope_or_secret_policy(){
        let root=tempfile::tempdir().unwrap();let home=root.path().join("home");let temp=root.path().join("tmp");std::fs::create_dir_all(home.join(".ssh")).unwrap();std::fs::create_dir(&temp).unwrap();
        let secret=home.join(".ssh/id_ed25519");std::fs::write(&secret,"not-read").unwrap();let alias=temp.join("image.png");std::os::unix::fs::symlink(secret,&alias).unwrap();assert!(read(&alias,&home,&temp).is_err());
    }
}
