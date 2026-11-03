//! Wire contract shared with the installed Windows COM activation registration.
//! Only a random correlation token enters Windows notification storage. Neither
//! launch arguments nor COM callbacks can specify a URL, command, or Host route.
pub const APP_ID: &str = "dev.varin.desktop";
pub const DEV_APP_ID: &str = "dev.varin.desktop.dev";
pub const ACTIVATOR_CLSID: &str = "34EDFA49-F833-482E-A268-C1D3610E6F17";
pub const DEV_ACTIVATOR_CLSID: &str = "A5A813AE-0884-46B0-BA3E-2DF39179377A";
pub const ACTIVATION_FLAG: &str = "--varin-notification-activation";
pub const TOAST_GROUP: &str = "VarinNative";
const PREFIX: &str = "varin-toast:v1:";

pub fn valid_token(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        && value.as_bytes()[12] == b'4'
        && matches!(value.as_bytes()[16], b'8' | b'9' | b'a' | b'b')
}

pub fn activation_argument(token: &str) -> Option<String> {
    valid_token(token).then(|| format!("{PREFIX}{token}"))
}

pub fn activation_token(argument: &str) -> Option<&str> {
    argument
        .strip_prefix(PREFIX)
        .filter(|token| valid_token(token))
}

/// Notification text is plain text, not caller-controlled toast XML. Discard
/// XML 1.0-invalid control characters, preserving tabs/newlines and Unicode.
pub fn toast_xml(token: &str, title: &str, body: &str) -> Option<String> {
    let argument = activation_argument(token)?;
    Some(format!(
        "<toast launch=\"{argument}\" activationType=\"foreground\"><visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text></binding></visual></toast>",
        xml_text(title),
        xml_text(body),
    ))
}

fn xml_text(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    for c in value.chars() {
        match c {
            '&' => result.push_str("&amp;"),
            '<' => result.push_str("&lt;"),
            '>' => result.push_str("&gt;"),
            '"' => result.push_str("&quot;"),
            '\'' => result.push_str("&apos;"),
            '\t'
            | '\n'
            | '\r'
            | '\u{20}'..='\u{d7ff}'
            | '\u{e000}'..='\u{fffd}'
            | '\u{10000}'..='\u{10ffff}' => result.push(c),
            _ => {}
        }
    }
    result
}

/// Banner timeout is not toast removal: it remains in Action Center and must
/// retain its original private route until activation/removal/shutdown.
pub fn keep_after_dismissal(reason: i32) -> bool {
    // UserCanceled describes leaving the screen too (for example swiping the
    // banner). The history, not that event name, establishes final removal.
    matches!(reason, 0 | 2)
}

#[cfg(test)]
mod tests {
    use super::*;
    const TOKEN: &str = "34edfa49f833482ea268c1d3610e6f17";

    #[test]
    fn only_versioned_random_tokens_are_accepted() {
        assert_eq!(
            activation_token(&activation_argument(TOKEN).unwrap()),
            Some(TOKEN)
        );
        for value in [
            "",
            "https://host/thread",
            "file:///app",
            "--run-command",
            "varin-toast:v1:",
            "varin-toast:v1:34EDFA49F833482EA268C1D3610E6F17",
            "varin-toast:v1:34edfa49f833482ea268c1d3610e6f17&url=evil",
            "varin-toast:v1:00000000000000000000000000000000",
        ] {
            assert_eq!(activation_token(value), None, "{value}");
        }
        assert_eq!(activation_argument("<toast>"), None);
    }

    #[test]
    fn hostile_text_cannot_add_toast_actions_or_attributes() {
        let xml = toast_xml(TOKEN, "<&\"'", "中文 🐈\0</text><actions>\u{ffff}\nbody").unwrap();
        assert!(xml.contains("&lt;&amp;&quot;&apos;"));
        assert!(xml.contains("中文 🐈&lt;/text&gt;&lt;actions&gt;\nbody"));
        assert_eq!(xml.matches("<toast ").count(), 1);
        assert!(!xml.contains("<actions>"));
    }

    #[test]
    fn action_center_keeps_timed_out_banner_route() {
        assert!(keep_after_dismissal(2));
        assert!(keep_after_dismissal(0)); // banner swipe can remain in history
        assert!(!keep_after_dismissal(1)); // application removal
    }

    #[test]
    fn installer_identity_matches_native_contract() {
        let installer = include_str!("../../installer/notification-registration.nsh");
        assert!(installer.contains(APP_ID));
        assert!(installer.contains(ACTIVATOR_CLSID));
        assert!(installer.contains(ACTIVATION_FLAG));
        assert_eq!(TOAST_GROUP, "VarinNative");
        assert_ne!(APP_ID, DEV_APP_ID);
        assert_ne!(ACTIVATOR_CLSID, DEV_ACTIVATOR_CLSID);
    }
}
