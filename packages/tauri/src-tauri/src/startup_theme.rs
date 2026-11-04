//! Non-secret presentation projection only. This does not write frontend stores
//! or release a Host bootstrap; the original migration importer owns that work.
use serde_json::{Value, json};

pub fn initialization_script(presentation: &Value) -> String {
    // Keep an explicit field boundary even if a future settings snapshot grows.
    let colors = |variant: &str| {
        json!({
            "background": presentation["splash"][variant]["background"].as_str(),
            "foreground": presentation["splash"][variant]["foreground"].as_str(),
        })
    };
    let mode = match presentation["mode"].as_str() {
        Some("light") => "light",
        Some("dark") => "dark",
        _ => "system",
    };
    let payload = json!({"mode":mode,"splash":{"light":colors("light"),"dark":colors("dark")}})
        .to_string()
        // CEF also inserts initialization scripts into bundled HTML. A color
        // value must remain data even if it contains an HTML script terminator.
        .replace('<', "\\u003c")
        .replace('>', "\\u003e")
        .replace('&', "\\u0026")
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029");
    format!(
        r#"(() => {{
  if (window.top !== window) return;
  const url = new URL(location.href);
  if (url.username || url.password || url.port || !(
    (url.protocol === 'tauri:' && url.hostname === 'localhost') ||
    ((url.protocol === 'http:' || url.protocol === 'https:') && url.hostname === 'tauri.localhost')
  )) return;
  window.__VARIN_STARTUP_THEME__ = {payload};
}})();"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    #[test]
    fn handoff_is_main_frame_application_only_and_keeps_values_as_data() {
        let attack = "</script><script>throw new Error('injected')</script>\u{2028}";
        let script = initialization_script(&json!({
            "mode":"dark","splash":{"dark":{"background":attack,"foreground":"#fff"}},
            "clientToken":"must-not-reach-page","requestHeaders":{"Authorization":"secret"}
        }));
        assert!(!script.contains('<'));
        assert!(!script.contains("must-not-reach-page"));
        assert!(!script.contains("Authorization"));
        // Execute the actual generated script, without CEF, a window, or sockets.
        let test = format!(
            r#"
const assert = require('node:assert/strict'), vm = require('node:vm');
for (const [href, child, admitted] of [
  ['tauri://localhost/index.html', false, true],
  ['https://tauri.localhost/index.html', false, true],
  ['http://tauri.localhost/mini-chat.html', false, true],
  ['https://example.test', false, false],
  ['tauri://localhost/index.html', true, false],
  ['https://tauri.localhost:456/index.html', false, false],
  ['http://user:password@tauri.localhost/index.html', false, false]
]) {{
  const window = {{}}; window.top = child ? {{}} : window;
  vm.runInNewContext({script}, {{window, location:{{href}}, URL}});
  assert.equal(!!window.__VARIN_STARTUP_THEME__, admitted);
  if (admitted) {{
    assert.equal(window.__VARIN_STARTUP_THEME__.mode, 'dark');
    assert.equal(window.__VARIN_STARTUP_THEME__.splash.dark.background, {attack});
    assert.equal(window.__VARIN_STARTUP_THEME__.clientToken, undefined);
  }}
}}
"#,
            script = serde_json::to_string(&script).unwrap(),
            attack = serde_json::to_string(attack).unwrap()
        );
        let result =
            Command::new(std::env::var_os("VARIN_TEST_NODE_PATH").unwrap_or_else(|| "node".into()))
                .args(["-e", &test])
                .output()
                .expect("Node is required for the pre-document handoff test");
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
    }
}
