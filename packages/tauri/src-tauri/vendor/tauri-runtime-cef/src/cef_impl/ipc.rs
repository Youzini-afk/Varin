// Copyright 2019-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use std::sync::{Arc, Mutex};

use cef::*;
use std::{cell::RefCell, collections::HashSet};
thread_local! { static IPC_BROWSERS: RefCell<HashSet<i32>> = RefCell::new(HashSet::new()); }
use tauri_runtime::{UserEvent, webview::DetachedWebview};

use crate::{
  cef_impl::client::TauriCefBrowserClient, runtime::CefRuntime, webview::CefWebviewDispatcher,
};

const IPC_MESSAGE_NAME: &str = "tauri:ipc";
const IPC_POST_MESSAGE_FUNCTION: &str = "postMessage";

pub(crate) type IpcHandler<T> =
  dyn Fn(DetachedWebview<T, CefRuntime<T>>, http::Request<String>) + Send;

wrap_v8_handler! {
  struct IpcPostMessageV8Handler;

  impl V8Handler {
    fn execute(
      &self,
      name: Option<&CefString>,
      _object: Option<&mut V8Value>,
      arguments: Option<&[Option<V8Value>]>,
      retval: Option<&mut Option<V8Value>>,
      exception: Option<&mut CefString>,
    ) -> std::os::raw::c_int {
      let Some(name) = name else {
        return 0;
      };
      if name.to_string() != IPC_POST_MESSAGE_FUNCTION {
        return 0;
      }

      let Some(message) = arguments
        .filter(|arguments| arguments.len() == 1)
        .and_then(|arguments| arguments[0].as_ref())
        .filter(|argument| argument.is_string() != 0)
      else {
        if let Some(exception) = exception {
          *exception = CefString::from("window.ipc.postMessage expects a string argument");
        }
        return 1;
      };

      let Some(context) = v8_context_get_current_context() else {
        return 1;
      };
      let Some(frame) = context.frame() else {
        return 1;
      };

      let body = CefString::from(&message.string_value()).to_string();
      let url = CefString::from(&frame.url()).to_string();
      let mut process_message = process_message_create(Some(&CefString::from(IPC_MESSAGE_NAME)));
      if let Some(args) = process_message
        .as_ref()
        .and_then(ProcessMessage::argument_list)
      {
        args.set_string(0, Some(&CefString::from(url.as_str())));
        args.set_string(1, Some(&CefString::from(body.as_str())));
        frame.send_process_message(ProcessId::BROWSER, process_message.as_mut());
      }

      if let Some(retval) = retval {
        *retval = v8_value_create_undefined();
      }
      1
    }
  }
}

fn install_ipc_post_message(context: Option<&mut V8Context>) {
  let Some(window) = context.and_then(|context| context.global()) else {
    return;
  };
  let attributes = sys::cef_v8_propertyattribute_t(
    [
      sys::cef_v8_propertyattribute_t::V8_PROPERTY_ATTRIBUTE_READONLY,
      sys::cef_v8_propertyattribute_t::V8_PROPERTY_ATTRIBUTE_DONTENUM,
      sys::cef_v8_propertyattribute_t::V8_PROPERTY_ATTRIBUTE_DONTDELETE,
    ]
    .into_iter()
    .fold(0, |acc, attr| acc | attr.0),
  )
  .into();
  let Some(mut ipc) = v8_value_create_object(None, None) else {
    return;
  };
  let mut handler = IpcPostMessageV8Handler::new();
  let post_message_name = CefString::from(IPC_POST_MESSAGE_FUNCTION);
  let Some(mut post_message) =
    v8_value_create_function(Some(&post_message_name), Some(&mut handler))
  else {
    return;
  };
  ipc.set_value_bykey(
    Some(&post_message_name),
    Some(&mut post_message),
    attributes,
  );
  window.set_value_bykey(Some(&CefString::from("ipc")), Some(&mut ipc), attributes);
}

wrap_render_process_handler! {
  pub struct TauriRenderProcessHandler;

  impl RenderProcessHandler {
    fn on_browser_created(&self, browser: Option<&mut Browser>, extra_info: Option<&mut DictionaryValue>) {
      if let Some(browser) = browser {
        if extra_info.is_some_and(|info| info.bool(Some(&CefString::from("varin:ipc-enabled"))) != 0) {
          IPC_BROWSERS.with_borrow_mut(|browsers| { browsers.insert(browser.identifier()); });
        }
      }
    }
    fn on_browser_destroyed(&self, browser: Option<&mut Browser>) {
      if let Some(browser) = browser {
        IPC_BROWSERS.with_borrow_mut(|browsers| { browsers.remove(&browser.identifier()); });
      }
    }
    fn on_context_created(
      &self,
      browser: Option<&mut Browser>,
      frame: Option<&mut Frame>,
      context: Option<&mut V8Context>,
    ) {
      // Child frames and native-only surfaces have no bridge, even if a future
      // renderer script accidentally learns Tauri's invocation encoding.
      if !frame.is_some_and(|frame| frame.is_main() != 0) { return; }
      if browser.is_some_and(|browser| IPC_BROWSERS.with_borrow(|ids| ids.contains(&browser.identifier()))) {
        install_ipc_post_message(context);
      }
    }
  }
}

pub(crate) fn on_process_message_received<T: UserEvent>(
  client: &TauriCefBrowserClient<T>,
  frame: Option<&mut Frame>,
  source_process: ProcessId,
  message: Option<&mut ProcessMessage>,
) -> std::os::raw::c_int {
  if source_process != ProcessId::RENDERER {
    return 0;
  }
  let Some(message) = message else {
    return 0;
  };
  if CefString::from(&message.name()).to_string() != IPC_MESSAGE_NAME {
    return 0;
  }
  let Some(handler) = client.handlers.ipc_handler.as_ref() else {
    return 1;
  };
  let Some(args) = message.argument_list() else {
    return 1;
  };

  let Some(frame) = frame.filter(|frame| frame.is_main() != 0) else { return 1; };
  // The CEF frame is authoritative; never trust a renderer-provided URL field.
  let url = CefString::from(&frame.url()).to_string();
  let body = CefString::from(&args.string(1)).to_string();

  if let Ok(request) = http::Request::builder().uri(url).body(body) {
    handler(
      DetachedWebview {
        label: client.label.clone(),
        dispatcher: CefWebviewDispatcher {
          window_id: Arc::new(Mutex::new(client.window_id)),
          webview_id: client.webview_id,
          context: client.context.clone(),
        },
      },
      request,
    );
  }
  1
}
