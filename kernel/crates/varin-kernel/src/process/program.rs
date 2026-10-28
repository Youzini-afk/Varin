//! Resolve against the child's cwd/environment, equally for pipes and PTYs.
use super::worker::Config;
use std::{
    io,
    path::{Path, PathBuf},
};

fn executable(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

pub(super) fn resolve(config: &Config) -> io::Result<PathBuf> {
    let command = Path::new(&config.command);
    if command.is_absolute() {
        return Ok(command.into());
    }
    if command.components().count() > 1 {
        return Ok(config.cwd.join(command));
    }
    let environment = |name: &str| {
        config
            .env
            .iter()
            .rev()
            .find(|entry| {
                if cfg!(windows) {
                    entry.name.eq_ignore_ascii_case(name)
                } else {
                    entry.name == name
                }
            })
            .map(|entry| entry.value.as_str())
    };
    #[cfg(windows)]
    let extensions = environment("PATHEXT")
        .unwrap_or(".COM;.EXE;.BAT;.CMD")
        .split(';')
        .filter(|value| !value.is_empty())
        .map(|value| format!("{}{}", if value.starts_with('.') { "" } else { "." }, value))
        .collect::<Vec<_>>();
    for directory in std::env::split_paths(environment("PATH").unwrap_or_default()) {
        let directory = if directory.is_absolute() {
            directory
        } else {
            config.cwd.join(directory)
        };
        let candidate = directory.join(command);
        if executable(&candidate) {
            return Ok(candidate);
        }
        #[cfg(windows)]
        if command.extension().is_none() {
            for extension in &extensions {
                let candidate = directory.join(format!("{}{extension}", config.command));
                if executable(&candidate) {
                    return Ok(candidate);
                }
            }
        }
    }
    Err(io::Error::new(io::ErrorKind::NotFound,format!("Program {:?} was not found in the process PATH; use an absolute executable path or configure PATH on the execution Host",config.command)))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn program_search_uses_child_path_and_cwd_instead_of_guardian_environment() {
        let root = std::env::temp_dir().join(format!("varin-program-{}", uuid::Uuid::new_v4()));
        let bin = root.join("bin with spaces");
        std::fs::create_dir_all(&bin).unwrap();
        let name = if cfg!(windows) { "probe.CMD" } else { "probe" };
        let program = bin.join(name);
        std::fs::write(&program, []).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let mut config:Config=serde_json::from_value(serde_json::json!({"processId":"lookup","kernelEpoch":"epoch",
            "receiptPath":root.join("receipt"),"jobName":"job","cwd":root,"command":"probe","args":[],
            "env":[{"name":"PATH","value":"bin with spaces"},{"name":"PATHEXT","value":".CMD"}],"mode":"pipe","cols":80,"rows":24})).unwrap();
        assert_eq!(resolve(&config).unwrap(), program);
        config.env.clear();
        assert_eq!(
            resolve(&config).unwrap_err().kind(),
            io::ErrorKind::NotFound
        );
        config.command = program.to_string_lossy().into_owned();
        assert_eq!(resolve(&config).unwrap(), program);
        std::fs::remove_dir_all(root).unwrap();
    }
}
