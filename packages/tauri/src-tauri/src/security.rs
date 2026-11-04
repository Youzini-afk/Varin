//! Application origins are compared structurally. Opaque URL origins must never
//! collapse unrelated custom schemes into the same string (`null`).
use url::Url;

pub fn application_origin(url: &Url) -> bool {
    url.username().is_empty() && url.password().is_none() && url.port().is_none()
        && matches!((url.scheme(), url.host_str()),
            ("tauri", Some("localhost")) | ("http" | "https", Some("tauri.localhost")))
}
pub fn same_application_origin(left: &Url, right: &Url) -> bool {
    application_origin(left) && application_origin(right)
        && left.scheme() == right.scheme() && left.host_str() == right.host_str()
        && left.port_or_known_default() == right.port_or_known_default()
}
pub fn browser_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "Invalid browser URL")?;
    if value == "about:blank" { return Ok(url); }
    if !matches!(url.scheme(), "http" | "https") || url.host_str() == Some("tauri.localhost")
        || !url.username().is_empty() || url.password().is_some() {
        return Err("Browser navigation cannot reach application assets or privileged schemes".into());
    }
    Ok(url)
}
#[cfg(test)] mod tests {
    use super::*;
    #[test] fn opaque_urls_do_not_share_authority() {
        let app = Url::parse("tauri://localhost/index.html").unwrap();
        assert!(same_application_origin(&app, &Url::parse("tauri://localhost/mini-chat.html").unwrap()));
        for candidate in ["tauri://evil/index.html", "varin-ui://app", "http://varin-preview.localhost/interactive", "https://tauri.localhost", "file:///tmp/index.html", "data:text/html,test", "tauri://localhost:123", "tauri://user@localhost"] {
            assert!(!same_application_origin(&app, &Url::parse(candidate).unwrap()), "{candidate}");
        }
    }
    #[test] fn browser_cannot_load_any_application_alias() {
        for candidate in ["http://tauri.localhost", "https://tauri.localhost:777/index.html", "tauri://localhost", "varin-ui://app", "file:///tmp/private", "javascript:alert(1)", "https://user:secret@example.com"] {
            assert!(browser_url(candidate).is_err(), "{candidate}");
        }
        for candidate in ["about:blank", "https://example.com", "http://localhost:57123"] { assert!(browser_url(candidate).is_ok()); }
    }
}
