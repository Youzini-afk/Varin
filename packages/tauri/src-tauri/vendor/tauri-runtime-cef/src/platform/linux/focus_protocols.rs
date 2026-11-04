// Copyright 2019-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use std::os::raw::c_ulong;

pub(crate) fn update_focus_protocols(protocols: &mut Vec<c_ulong>, take_focus: c_ulong, focusable: bool) {
  protocols.retain(|atom| *atom != take_focus);
  if focusable {
    protocols.push(take_focus);
  }
}

#[cfg(test)]
mod focus_tests {
  use super::*;

  #[test]
  fn focus_protocol_changes_preserve_close_and_other_wm_protocols() {
    let mut protocols = vec![10, 20, 30];
    update_focus_protocols(&mut protocols, 20, false);
    assert_eq!(protocols, vec![10, 30]);
    update_focus_protocols(&mut protocols, 20, false);
    assert_eq!(protocols, vec![10, 30]);
    update_focus_protocols(&mut protocols, 20, true);
    update_focus_protocols(&mut protocols, 20, true);
    assert_eq!(protocols, vec![10, 30, 20]);
  }
}
