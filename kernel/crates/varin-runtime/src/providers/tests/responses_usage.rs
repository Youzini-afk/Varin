use super::*;

#[test]
fn azure_and_codex_keep_the_shared_responses_cache_write_receipt() {
    struct FixtureAccount;
    impl CredentialResolver for FixtureAccount {
        fn headers(
            &self,
            _: Option<&str>,
            _: &CancellationToken,
        ) -> Result<reqwest::header::HeaderMap, ModelFailure> {
            let mut headers = reqwest::header::HeaderMap::new();
            headers.insert(
                reqwest::header::AUTHORIZATION,
                "Bearer fixture-only".parse().unwrap(),
            );
            headers.insert("chatgpt-account-id", "fixture-account".parse().unwrap());
            Ok(headers)
        }
    }
    for family in [azure::FAMILY, codex::FAMILY] {
        let mut conn = connection(
            vec![json!({"type":"response.completed", "response":{
                "output":[], "usage":{"input_tokens":100, "output_tokens":5,
                    "input_tokens_details":{"cached_tokens":20, "cache_write_tokens":30}}
            }})],
            1,
        );
        conn.credentials = Arc::new(FixtureAccount);
        let (result, events) = match family {
            azure::FAMILY => generate(
                &azure::AzureResponsesProvider::new(conn, "model", "2025-04-01-preview").unwrap(),
                family,
            ),
            codex::FAMILY => generate(&codex::CodexProvider::new(conn), family),
            _ => unreachable!(),
        };
        assert_eq!(result.unwrap(), FinishReason::Stop);
        assert!(
            events
                .iter()
                .any(|event| matches!(event, ProviderEvent::Usage { receipt }
            if receipt.cache_write_tokens == Some(30) && receipt.cached_input_tokens == Some(20))),
            "{family}"
        );
    }
}

#[test]
fn responses_cache_writes_survive_every_terminal_event_without_inventing_missing_counts() {
    for terminal in [
        "response.completed",
        "response.incomplete",
        "response.failed",
    ] {
        for (reported, expected) in [
            (None, None),
            (Some(Value::Null), None),
            (Some(json!(-1)), None),
            (Some(json!(1.5)), None),
            (Some(json!("7000")), None),
            (Some(json!(0)), Some(0)),
            (Some(json!(7000)), Some(7000)),
        ] {
            let mut usage = json!({"input_tokens":12000,"output_tokens":300,
                "input_tokens_details":{"cached_tokens":4000},
                "output_tokens_details":{"reasoning_tokens":10}});
            if let Some(value) = reported {
                usage["input_tokens_details"]["cache_write_tokens"] = value;
            }
            let provider = responses::ResponsesProvider::new(connection(
                vec![json!({
                    "type": terminal,
                    "response": {"output":[], "usage":usage,
                        "incomplete_details":{"reason":"max_output_tokens"},
                        "error":{"code":"server_error"}}
                })],
                1,
            ));
            let (result, events) = generate(&provider, responses::FAMILY);
            assert_eq!(result.is_err(), terminal == "response.failed");
            let receipts: Vec<_> = events
                .iter()
                .filter_map(|event| match event {
                    ProviderEvent::Usage { receipt } => Some(receipt),
                    _ => None,
                })
                .collect();
            assert_eq!(receipts.len(), 1);
            assert_eq!(receipts[0].cache_write_tokens, expected, "{terminal}");
            assert_eq!(receipts[0].input_tokens, Some(12000));
            assert_eq!(receipts[0].cached_input_tokens, Some(4000));
            assert_eq!(receipts[0].output_tokens, Some(300));
            assert_eq!(receipts[0].raw.as_ref(), Some(&usage));
        }
    }
}

#[test]
fn responses_retains_cache_write_lifetimes_in_the_original_receipt() {
    let usage = json!({"input_tokens":12000,"output_tokens":300,
        "input_tokens_details":{"cached_tokens":4000,"cache_write_tokens":7000,
            "cache_write_tokens_details":{"ttl_30m_tokens":3000,"ttl_12h_tokens":4000}}});
    let provider = responses::ResponsesProvider::new(connection(
        vec![json!({
            "type":"response.completed", "response":{"output":[],"usage":usage}
        })],
        7,
    ));
    let (result, events) = generate(&provider, responses::FAMILY);
    assert_eq!(result.unwrap(), FinishReason::Stop);
    assert!(events
        .iter()
        .any(|event| matches!(event, ProviderEvent::Usage { receipt }
        if receipt.cache_write_tokens == Some(7000) && receipt.raw.as_ref() == Some(&usage))));
}
