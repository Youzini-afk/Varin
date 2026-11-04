// Copyright 2019-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use std::{ffi::CStr, sync::RwLock};

/// Native presentation labels indexed by stable Chromium command names, never
/// by the page's text or spellcheck suggestions. Existing webviews read the
/// latest snapshot whenever a context menu opens.
static LABELS: RwLock<Vec<(&'static CStr, String)>> = RwLock::new(Vec::new());

pub fn set_context_menu_labels(labels: Vec<(&'static CStr, String)>) {
  *LABELS.write().unwrap_or_else(|error| error.into_inner()) = labels;
}

pub(crate) fn context_menu_labels() -> Vec<(&'static CStr, String)> {
  LABELS.read().unwrap_or_else(|error| error.into_inner()).clone()
}
