// Windows behavior was ported from Varin's former PowerShell/C# driver, itself
// adapted in part from open-codex-computer-use (MIT, baseline 51f3a59).
// The complete upstream notice remains in the repository THIRD_PARTY_NOTICES.md.
//! The Computer helper owns only one desktop connection's native resources.
//! Protocol and relocation rules are portable; COM and desktop APIs are Windows-only.
pub mod protocol;
pub mod targeting;
#[cfg(windows)]
pub mod windows;

#[cfg(all(test, not(windows)))]
#[path = "windows/window.rs"]
mod window_selection;
