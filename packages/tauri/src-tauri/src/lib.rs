#[cfg(feature = "desktop")]
mod browser;
#[cfg(feature = "desktop")]
mod cdp;
#[cfg(any(feature = "desktop", test))]
mod cdp_settlement;
#[cfg(feature = "desktop")]
mod companion;
#[cfg(any(feature = "desktop", test))]
mod companion_registry;
#[cfg(all(test, not(feature = "desktop")))]
#[path = "engine/pixels.rs"]
mod compositor_pixels_tests;
#[cfg(feature = "desktop")]
mod computer;
#[cfg(feature = "desktop")]
mod desktop;
#[cfg(feature = "desktop")]
pub mod engine;
pub mod files;
#[cfg(feature = "process-owner")]
pub mod process_owner;
pub mod host;
pub mod host_codec;
mod host_scope;
#[cfg(windows)]
mod host_windows_guardian;
mod desktop_windows_boot;
#[cfg(unix)]
mod host_guardian;
#[cfg(unix)]
pub use host_guardian::run_if_requested as run_service_guardian_if_requested;
#[cfg(feature = "desktop")]
mod lifecycle;
pub mod manifest;
#[cfg(feature = "desktop")]
pub(crate) mod native_menu;
#[cfg(feature = "desktop")]
mod power;
pub mod security;
#[cfg(any(feature = "desktop", test))]
mod window_registry;
#[cfg(feature = "desktop")]
mod service;
pub mod settings;
#[cfg(feature = "desktop")]
pub fn run() {
    desktop::run();
}

#[cfg(all(test, not(feature = "desktop")))]
#[path = "engine/network_ring.rs"]
mod network_ring_tests;

#[cfg(feature = "desktop")]
mod platform;

#[path = "companion_geometry.rs"]
pub mod geometry;
pub mod window_geometry;

#[cfg(any(all(feature = "desktop", target_os = "linux"), test))]
mod update_format;
pub mod update_metadata;
#[cfg(feature = "desktop")]
pub mod updater;

pub mod desktop_lock;
#[cfg(any(feature = "desktop", test))]
mod preengine_activation;

pub mod native_presentation;

#[cfg(feature = "desktop")]
mod native_notifications;

pub mod update_install;

#[cfg(any(feature = "desktop", test))]
mod update_progress;

#[cfg(feature = "desktop")]
mod legacy_migration;
pub mod legacy_migration_data;
#[path = "smoke/application_data.rs"]
pub mod smoke_application_data;

#[cfg(feature = "desktop")]
mod smoke;

#[cfg(feature = "desktop")]
mod dialogs;

#[cfg(feature = "desktop")]
mod benchmark;

#[cfg(any(feature = "desktop", test))]
mod computer_registry;

#[cfg(any(feature = "desktop", test))]
mod preview;

#[cfg(any(feature = "desktop", test))]
mod startup_theme;
