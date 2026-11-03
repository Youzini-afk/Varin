//! Linux installation format is native authority, never a renderer choice.
use std::path::PathBuf;

pub enum LinuxBundle {
    Deb,
    AppImage,
    Unstamped,
    Other,
}

pub fn appimage_path(bundle: LinuxBundle, appimage: Option<PathBuf>) -> Result<PathBuf, String> {
    match bundle {
        LinuxBundle::Deb => return Err("This Debian installation is managed by your system package manager. Install the newer Varin .deb package through your system installer; in-app Debian updates are not enabled.".into()),
        LinuxBundle::Other => return Err("In-app updates are unavailable for this Linux package format".into()),
        LinuxBundle::AppImage | LinuxBundle::Unstamped => {},
    }
    // Electron-builder assembled earlier AppImages without a Tauri stamp.
    // APPIMAGE remains supported for those builds, never for stamped Deb/RPM.
    let file =
        appimage.ok_or("Updates require the installed AppImage, not an extracted application")?;
    if !file.is_absolute() || !file.is_file() {
        return Err("The installed AppImage is unavailable".into());
    }
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stamped_deb_rejects_even_a_real_spoofed_appimage_before_installation() {
        let file = tempfile::NamedTempFile::new().unwrap();
        for path in [None, Some(file.path().to_owned())] {
            assert!(
                appimage_path(LinuxBundle::Deb, path)
                    .unwrap_err()
                    .contains("package manager")
            );
        }
        assert!(appimage_path(LinuxBundle::Other, Some(file.path().to_owned())).is_err());
    }

    #[test]
    fn appimage_and_legacy_unstamped_builds_require_an_existing_absolute_image() {
        let file = tempfile::NamedTempFile::new().unwrap();
        for bundle in [LinuxBundle::AppImage, LinuxBundle::Unstamped] {
            assert_eq!(
                appimage_path(bundle, Some(file.path().to_owned())).unwrap(),
                file.path()
            );
        }
        assert!(appimage_path(LinuxBundle::AppImage, None).is_err());
        assert!(
            appimage_path(
                LinuxBundle::Unstamped,
                Some(PathBuf::from("relative.AppImage"))
            )
            .is_err()
        );
        assert!(
            appimage_path(
                LinuxBundle::AppImage,
                Some(file.path().with_extension("missing"))
            )
            .is_err()
        );
    }
}
