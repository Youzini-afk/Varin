// Copyright 2019-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use cef::*;
use std::sync::{
  Arc,
  atomic::{AtomicBool, Ordering},
};

wrap_focus_handler! {
  pub(crate) struct TauriCefFocusHandler {
    focusable: Arc<AtomicBool>,
  }

  impl FocusHandler {
    fn on_set_focus(&self, _browser: Option<&mut Browser>, _source: FocusSource) -> i32 {
      // Cancel focus, not the mouse event. Native CEF children can otherwise
      // focus themselves independently of the parent window manager hints.
      i32::from(!self.focusable.load(Ordering::Acquire))
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn browser_focus_veto_tracks_live_policy_for_all_sources() {
    let allowed = Arc::new(AtomicBool::new(true));
    let handler = TauriCefFocusHandler::new(allowed.clone());
    for source in [FocusSource::NAVIGATION, FocusSource::SYSTEM] {
      assert_eq!(handler.on_set_focus(None, source), 0);
      allowed.store(false, Ordering::Release);
      assert_eq!(handler.on_set_focus(None, source), 1);
      allowed.store(true, Ordering::Release);
      assert_eq!(handler.on_set_focus(None, source), 0);
    }
  }
}
