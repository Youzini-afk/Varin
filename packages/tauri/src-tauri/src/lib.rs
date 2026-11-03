#[cfg(feature = "desktop")]
mod browser;
#[cfg(feature = "desktop")]
mod cdp;
#[cfg(feature = "desktop")]
mod companion;
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
pub mod host;
pub mod host_codec;
mod host_scope;
#[cfg(feature = "desktop")]
mod lifecycle;
pub mod manifest;
#[cfg(feature = "desktop")]
pub(crate) mod native_menu;
#[cfg(feature = "desktop")]
mod power;
pub mod security;
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

pub mod update_metadata;
#[cfg(feature = "desktop")]
pub mod updater;

pub mod desktop_lock;

pub mod native_presentation;

#[cfg(feature = "desktop")]
mod native_notifications;

pub mod update_install;

#[cfg(feature = "desktop")]
mod legacy_migration;
pub mod legacy_migration_data;

#[cfg(feature = "desktop")]
mod smoke;

#[cfg(feature = "desktop")]
mod dialogs;
