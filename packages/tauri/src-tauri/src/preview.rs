//! Presentation-only HTML runs outside the packaged application's CSP/origin.
//! This protocol serves one static bootstrap, not files or arbitrary URLs. The
//! opaque sandbox has no native capability, Host identity or credential input.
const BOOTSTRAP: &str = include_str!("preview.html");
const INTERACTIVE_CSP: &str = "default-src 'none'; script-src 'unsafe-inline' blob: https:; style-src 'unsafe-inline' blob: https:; img-src data: blob: https: http:; font-src data: blob: https:; media-src data: blob: https: http:; connect-src blob: data: https: http:; worker-src blob:; frame-src https: http:; object-src 'none'; base-uri https:; form-action 'none'; frame-ancestors http://tauri.localhost https://tauri.localhost; sandbox allow-scripts";
const FEEDBACK_CSP: &str = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors http://tauri.localhost https://tauri.localhost; sandbox allow-scripts";

fn document(method: &str, path: &str) -> Option<(&'static str, &'static str)> {
    if method != "GET" {
        return None;
    }
    match path {
        "/interactive" => Some((BOOTSTRAP, INTERACTIVE_CSP)),
        "/feedback" => Some((BOOTSTRAP, FEEDBACK_CSP)),
        _ => None,
    }
}

#[cfg(feature = "desktop")]
pub fn register_protocol(builder: tauri::Builder) -> tauri::Builder {
    builder.register_uri_scheme_protocol("varin-preview", |_context, request| {
        let Some((body, csp)) = document(request.method().as_str(), request.uri().path()) else {
            return tauri::http::Response::builder()
                .status(404)
                .body(Vec::new())
                .unwrap();
        };
        tauri::http::Response::builder()
            .header("Content-Type", "text/html; charset=utf-8")
            .header("Content-Security-Policy", csp)
            .header("Cache-Control", "no-store")
            .header("Referrer-Policy", "no-referrer")
            .header("X-Content-Type-Options", "nosniff")
            .body(body.as_bytes().to_vec())
            .unwrap()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_serves_the_two_static_sandbox_bootstraps() {
        for path in [
            "/",
            "/interactive/asset",
            "/private/file",
            "/feedback/../interactive",
        ] {
            assert!(document("GET", path).is_none());
        }
        for method in ["POST", "PUT", "HEAD", "DELETE"] {
            assert!(document(method, "/interactive").is_none());
        }
        for path in ["/interactive", "/feedback"] {
            let (body, csp) = document("GET", path).unwrap();
            assert_eq!(body, BOOTSTRAP);
            let directives: std::collections::HashMap<_, _> = csp
                .split(';')
                .map(|directive| {
                    let mut words = directive.split_whitespace();
                    (words.next().unwrap(), words.collect::<Vec<_>>())
                })
                .collect();
            assert_eq!(directives["sandbox"], ["allow-scripts"]);
            assert_eq!(directives["default-src"], ["'none'"]);
            assert_eq!(directives["object-src"], ["'none'"]);
            assert_eq!(directives["form-action"], ["'none'"]);
            assert!(!directives["script-src"].contains(&"'unsafe-eval'"));
        }
        // The renderer resolves work-local CSS and fetchable JSON/assets into
        // object/data URLs. Their resource policies must allow those forms.
        let (_, csp) = document("GET", "/interactive").unwrap();
        let directives: std::collections::HashMap<_, _> = csp
            .split(';')
            .map(|directive| {
                let mut words = directive.split_whitespace();
                (words.next().unwrap(), words.collect::<Vec<_>>())
            })
            .collect();
        assert!(directives["style-src"].contains(&"blob:"));
        assert!(directives["connect-src"].contains(&"blob:"));
        assert!(directives["connect-src"].contains(&"data:"));
        let (_, csp) = document("GET", "/feedback").unwrap();
        assert!(!csp.contains("connect-src")); // No network in the gesture overlay.
    }
}
