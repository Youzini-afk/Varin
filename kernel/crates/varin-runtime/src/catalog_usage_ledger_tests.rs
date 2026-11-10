use super::*;

struct Fixture(std::path::PathBuf, Catalog);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("varin-usage-ledger-{}", Uuid::new_v4()));
        let db = Catalog::open(&root).unwrap();
        Self(root, db)
    }
    /// Settle one request through the ledger writer, then pin its settle time for the test.
    fn settle(
        &mut self,
        id: &str,
        at_ms: i64,
        family: &str,
        pricing: Option<Value>,
        usage: UsageReceipt,
    ) {
        let attribution = UsageAttribution {
            provider_id: Some("channel".into()),
            provider_family: Some(family.into()),
            model: "model".into(),
            connection_identity: String::new(),
            pricing: pricing.map(|value| serde_json::from_value(value).unwrap()),
        };
        let tx = self.1.db.transaction().unwrap();
        record(
            &tx,
            UsageEntry {
                id: id.into(),
                kind: UsageKind::Conversation,
                purpose: None,
                run_id: "standalone",
                attribution: &attribution,
                usage: &usage,
            },
            Settlement::Final,
        )
        .unwrap();
        tx.execute(
            "UPDATE usage_records SET at_ms=?2 WHERE id=?1",
            params![id, at_ms],
        )
        .unwrap();
        tx.commit().unwrap();
    }
    fn summary(&self, from_ms: u64, to_ms: u64, utc_offset_minutes: i64) -> UsageSummary {
        self.1
            .capture_usage_summary(&UsageSummaryParams {
                from_ms,
                to_ms,
                utc_offset_minutes,
                days: vec![],
                current_prices: vec![],
            })
            .unwrap()
            .load(&|| false)
            .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn usage(
    input: Option<u64>,
    cached: Option<u64>,
    write: Option<u64>,
    output: Option<u64>,
) -> UsageReceipt {
    UsageReceipt {
        measurement: UsageMeasurement::Actual,
        input_tokens: input,
        cached_input_tokens: cached,
        cache_write_tokens: write,
        output_tokens: output,
        ..Default::default()
    }
}
fn price(billing: &str, extra: Value) -> Value {
    let mut value = json!({"currency":"USD","billing":billing,"source":"directory","version":"models.dev:2026-11-01",
        "inputPerMillion":2.0,"outputPerMillion":8.0});
    value
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    value
}
fn close(actual: f64, expected: f64) {
    assert!((actual - expected).abs() < 1e-9, "{actual} != {expected}");
}
const DAY: i64 = 86_400_000;
// 2026-11-01T00:00:00Z
const NOV_1: i64 = 1_793_491_200_000;

#[test]
fn price_snapshots_are_validated_and_older_configurations_still_load() {
    let base = json!({"providerFamily":"openai-responses","model":"m","endpoint":"https://model.invalid/v1","credentialEnvironment":null,
        "allowAnonymous":false,"configurationGeneration":1,"maxOutputTokens":null});
    let old: ModelSessionConfiguration = serde_json::from_value(base.clone()).unwrap();
    assert_eq!(old.pricing, None);
    let snapshot = json!({"currency":"USD","billing":"subscription","source":"custom","version":"user:7","inputPerMillion":3.0,
        "cacheReadPerMillion":0.3,"longContext":{"aboveInputTokens":200000,"inputPerMillion":6.0}});
    let mut priced = base.clone();
    priced["pricing"] = snapshot.clone();
    let configuration: ModelSessionConfiguration = serde_json::from_value(priced).unwrap();
    let pricing = configuration.pricing.clone().unwrap();
    assert_eq!(
        (pricing.billing, pricing.source, pricing.output_per_million),
        (UsageBilling::Subscription, PriceSource::Custom, None)
    );
    assert_eq!(serde_json::to_value(&pricing).unwrap(), snapshot);
    // Price changes never alter execution identity; any other field still does.
    assert_ne!(configuration, old);
    assert!(configuration.same_identity(&old) && old.same_identity(&configuration));
    let mut other_model = old.clone();
    other_model.model = "other".into();
    assert!(!configuration.same_identity(&other_model));
    other_model.pricing = configuration.pricing.clone();
    assert!(!configuration.same_identity(&other_model));
    // Without a snapshot the stored body is byte-identical to earlier configurations.
    let stored = serde_json::to_value(&old).unwrap();
    assert!(!stored.as_object().unwrap().contains_key("pricing"));
    assert!(same_configuration(
        &serde_json::to_value(&configuration).unwrap(),
        &stored
    ));

    for (field, value) in [
        ("currency", json!("EUR")),
        ("inputPerMillion", json!(-0.5)),
        ("billing", json!("prepaid")),
        ("longContext", json!({"aboveInputTokens":0})),
        ("longContext", json!({"aboveInputTokens":1.5})),
        ("unknownPrice", json!(1)),
    ] {
        let mut invalid = snapshot.clone();
        invalid[field] = value;
        let mut priced = base.clone();
        priced["pricing"] = invalid;
        assert!(
            serde_json::from_value::<ModelSessionConfiguration>(priced).is_err(),
            "{field} was accepted"
        );
    }
    // Stored bindings and request snapshots from before price snapshots keep decoding.
    let binding: crate::catalog::inference::InferenceBinding = serde_json::from_value(json!({"requestKind":"model_compute","purpose":"title",
        "providerId":"p","modelId":"m","configurationId":"c","executor":{"kind":"local_component","componentId":"c","componentVersion":"1",
        "manifestDigest":"d","modelRevision":"r","workerProtocol":1}})).unwrap();
    assert!(
        binding.pricing.is_none()
            && !serde_json::to_value(&binding)
                .unwrap()
                .as_object()
                .unwrap()
                .contains_key("pricing")
    );
}

#[test]
fn summary_buckets_local_days_and_reads_a_half_open_range() {
    let mut f = Fixture::new();
    let before_midnight = NOV_1 + 16 * 3_600_000 - 1; // 23:59:59.999 at UTC+8
    f.settle(
        "late",
        before_midnight,
        "openai-responses",
        None,
        usage(Some(10), None, None, Some(1)),
    );
    f.settle(
        "next",
        before_midnight + 1,
        "openai-responses",
        None,
        usage(Some(20), None, None, Some(2)),
    );
    f.settle(
        "outside",
        NOV_1 + DAY,
        "openai-responses",
        None,
        usage(Some(30), None, None, Some(3)),
    );
    let summary = f.summary(NOV_1 as u64, (NOV_1 + DAY) as u64, 8 * 60);
    assert!(summary.recording_started_at_ms.is_some());
    let days: Vec<_> = summary
        .rows
        .iter()
        .map(|row| {
            (
                row.day.as_str(),
                row.requests,
                row.input_tokens.known.as_deref(),
            )
        })
        .collect();
    assert_eq!(
        days,
        [("2026-11-01", 1, Some("10")), ("2026-11-02", 1, Some("20"))]
    );
    // A western offset moves the same instants back into the UTC calendar day.
    let western = f.summary(NOV_1 as u64, (NOV_1 + DAY + 1) as u64, -5 * 60);
    assert_eq!(
        western
            .rows
            .iter()
            .map(|row| (row.day.as_str(), row.requests))
            .collect::<Vec<_>>(),
        [("2026-11-01", 3)]
    );
    for params in [
        (10, 10, 0),
        (10, 5, 0),
        (0, 10, 14 * 60 + 1),
        (0, 10, -14 * 60 - 1),
    ] {
        assert!(f
            .1
            .capture_usage_summary(&UsageSummaryParams {
                from_ms: params.0,
                to_ms: params.1,
                utc_offset_minutes: params.2,
                days: vec![],
                current_prices: vec![]
            })
            .is_err());
    }
    assert!(f
        .1
        .capture_usage_summary(&UsageSummaryParams {
            from_ms: 0,
            to_ms: 400 * DAY as u64,
            utc_offset_minutes: -14 * 60,
            days: vec![],
            current_prices: vec![]
        })
        .is_ok());
    assert!(f
        .1
        .capture_usage_summary(&UsageSummaryParams {
            from_ms: 0,
            to_ms: 1,
            utc_offset_minutes: 0,
            days: vec![],
            current_prices: vec![]
        })
        .unwrap()
        .load(&|| true)
        .is_err());
}

#[test]
fn current_prices_fill_unknown_rates_without_rewriting_historical_receipts() {
    let mut f = Fixture::new();
    f.settle(
        "unpriced",
        NOV_1,
        "openai-responses",
        None,
        usage(Some(1_000_000), None, None, Some(100_000)),
    );
    let original: String =
        f.1.db
            .query_row(
                "SELECT body FROM usage_records WHERE id='unpriced'",
                [],
                |row| row.get(0),
            )
            .unwrap();
    let pricing: UsagePricing = serde_json::from_value(price(
        "metered",
        json!({"inputPerMillion":2,"outputPerMillion":8}),
    ))
    .unwrap();
    let query = UsageSummaryParams {
        from_ms: NOV_1 as u64,
        to_ms: (NOV_1 + DAY) as u64,
        utc_offset_minutes: 0,
        days: vec![],
        current_prices: vec![UsageCurrentPrice {
            provider_id: "channel".into(),
            model_id: "model".into(),
            pricing,
        }],
    };
    let rows =
        f.1.capture_usage_summary(&query)
            .unwrap()
            .load(&|| false)
            .unwrap()
            .rows;
    close(rows[0].cost_usd, 2.8);
    assert_eq!(rows[0].current_price_requests, 1);
    assert_eq!(
        f.1.db
            .query_row(
                "SELECT body FROM usage_records WHERE id='unpriced'",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        original
    );
}

#[test]
fn multiple_context_tiers_and_reasoning_rates_use_each_token_once() {
    let mut f = Fixture::new();
    let pricing = price(
        "metered",
        json!({"inputPerMillion":1,"outputPerMillion":8,"reasoningPerMillion":8,
        "contextTiers":[{"aboveInputTokens":32000,"inputPerMillion":2},{"aboveInputTokens":128000,"inputPerMillion":3,"outputPerMillion":10}]}),
    );
    let mut receipt = usage(Some(300000), None, None, Some(100));
    receipt.reasoning_tokens = Some(20);
    f.settle(
        "reasoned",
        NOV_1,
        "openai-responses",
        Some(pricing),
        receipt,
    );
    let result = f.summary(NOV_1 as u64, (NOV_1 + DAY) as u64, 0);
    close(
        result.rows[0].cost_usd,
        (300000.0 * 3.0 + 80.0 * 10.0 + 20.0 * 8.0) / 1e6,
    );
}

#[test]
fn estimated_cost_follows_reported_cache_accounting_and_price_tiers() {
    let mut f = Fixture::new();
    let read = json!({"cacheReadPerMillion":0.5});
    // Inclusive family: 1M input includes 400k cache reads.
    f.settle(
        "inclusive",
        NOV_1,
        "openai-responses",
        Some(price("metered", read.clone())),
        usage(Some(1_000_000), Some(400_000), None, Some(100_000)),
    );
    // Separate-cache family: complete input is input + reads + writes.
    f.settle(
        "separate",
        NOV_1,
        "anthropic-messages",
        Some(price(
            "metered",
            json!({"inputPerMillion":3.0,"outputPerMillion":15.0,
        "cacheReadPerMillion":0.3,"cacheWritePerMillion":3.75}),
        )),
        usage(Some(100_000), Some(800_000), Some(100_000), Some(50_000)),
    );
    // Above the threshold every price comes from the long-context tier when it has one.
    f.settle("long", NOV_1, "openai-responses", Some(price("metered", json!({"longContext":{"aboveInputTokens":200_000,"inputPerMillion":6.0,"outputPerMillion":22.5}}))),
        usage(Some(300_000), None, None, Some(10_000)));
    f.settle(
        "subscription",
        NOV_1,
        "openai-responses",
        Some(price("subscription", json!({}))),
        usage(Some(500_000), None, None, Some(0)),
    );
    f.settle(
        "local",
        NOV_1,
        "openai-responses",
        Some(price("local", json!({}))),
        usage(Some(500_000), None, None, Some(10)),
    );
    f.settle(
        "unpriced",
        NOV_1,
        "openai-responses",
        None,
        usage(Some(500_000), None, None, Some(10)),
    );
    let summary = f.summary(NOV_1 as u64, (NOV_1 + 1) as u64, 0);
    let row = |family: &str, billing: Option<UsageBilling>| {
        summary
            .rows
            .iter()
            .filter(|row| row.provider_family.as_deref() == Some(family) && row.billing == billing)
            .collect::<Vec<_>>()
    };
    let inclusive = row("openai-responses", Some(UsageBilling::Metered));
    assert_eq!(inclusive.len(), 1);
    assert_eq!(
        (
            inclusive[0].requests,
            inclusive[0].priced,
            inclusive[0].cost_unknown_requests
        ),
        (2, true, 0)
    );
    // 600k uncached x $2 + 400k reads x $0.5 + 100k output x $8, plus the long tier: 300k x $6 + 10k x $22.5.
    close(inclusive[0].cost_usd, 1.2 + 0.2 + 0.8 + 1.8 + 0.225);
    close(inclusive[0].cache_saved_usd, 0.4 * 1.5);
    assert_eq!(inclusive[0].price_sources, [PriceSource::Directory]);
    let separate = row("anthropic-messages", Some(UsageBilling::Metered));
    assert_eq!(
        separate[0].complete_input_tokens.known.as_deref(),
        Some("1000000")
    );
    close(separate[0].cost_usd, 0.3 + 0.24 + 0.375 + 0.75);
    close(separate[0].cache_saved_usd, 0.8 * (3.0 - 0.3));
    let subscription = row("openai-responses", Some(UsageBilling::Subscription));
    assert!(subscription[0].priced);
    close(subscription[0].reference_usd, 1.0);
    close(subscription[0].cost_usd, 0.0);
    for billing in [Some(UsageBilling::Local), None] {
        let unpriced = row("openai-responses", billing);
        assert_eq!(
            (
                unpriced[0].priced,
                unpriced[0].cost_usd,
                unpriced[0].cost_unknown_requests
            ),
            (false, 0.0, 0)
        );
        assert_eq!(unpriced[0].input_tokens.known.as_deref(), Some("500000"));
    }
}

#[test]
fn unreported_counts_leave_cost_unknown_rather_than_zero() {
    let mut f = Fixture::new();
    let read = json!({"cacheReadPerMillion":0.5});
    f.settle(
        "no-output",
        NOV_1,
        "openai-responses",
        Some(price("metered", read.clone())),
        usage(Some(100), Some(0), None, None),
    );
    // Unreported reads priced unlike input change the amount; unreported writes billed as input do not.
    f.settle(
        "no-reads",
        NOV_1,
        "openai-responses",
        Some(price("metered", read.clone())),
        usage(Some(100), None, None, Some(1)),
    );
    f.settle(
        "missing",
        NOV_1,
        "openai-responses",
        Some(price("metered", read)),
        UsageReceipt::default(),
    );
    f.settle(
        "unknown-family",
        NOV_1,
        "fixture-family",
        Some(price("metered", json!({}))),
        usage(Some(100), None, None, Some(1)),
    );
    f.settle("no-input-price", NOV_1, "openai-responses", Some(json!({"currency":"USD","billing":"metered","source":"directory","version":"v","outputPerMillion":1.0})),
        usage(Some(100), None, None, Some(1)));
    let summary = f.summary(NOV_1 as u64, (NOV_1 + 1) as u64, 0);
    let priced: Vec<_> = summary.rows.iter().filter(|row| row.priced).collect();
    assert_eq!(priced.iter().map(|row| row.requests).sum::<u64>(), 4);
    assert_eq!(
        priced
            .iter()
            .map(|row| row.cost_unknown_requests)
            .sum::<u64>(),
        4
    );
    assert!(priced.iter().all(|row| row.cost_usd == 0.0));
    let missing = summary
        .rows
        .iter()
        .find(|row| row.measurement == UsageMeasurement::Missing)
        .unwrap();
    assert_eq!(
        (
            missing.input_tokens.known.as_deref(),
            missing.input_tokens.missing
        ),
        (None, 1)
    );
    assert_eq!(
        (
            missing.output_tokens.missing,
            missing.complete_input_tokens.missing
        ),
        (1, 1)
    );
    let unpriced = summary.rows.iter().find(|row| !row.priced).unwrap();
    assert_eq!(
        (unpriced.billing, unpriced.requests),
        (Some(UsageBilling::Metered), 1)
    );
}

#[test]
fn responses_cache_write_prices_use_inclusive_input_and_preserve_unknown_counts() {
    let mut f = Fixture::new();
    let pricing = price("metered", json!({"inputPerMillion":2.0,"outputPerMillion":10.0,
        "cacheReadPerMillion":0.1,"cacheWritePerMillion":2.5}));
    for (index, written) in [Some(7000), Some(0), None].into_iter().enumerate() {
        let at = NOV_1 + index as i64 * DAY;
        f.settle(&format!("responses-{index}"), at, "openai-responses", Some(pricing.clone()),
            usage(Some(12000), Some(4000), written, Some(300)));
        let rows = f.summary(at as u64, (at + 1) as u64, 0).rows;
        assert_eq!(rows.len(), 1);
        let row = &rows[0];
        assert_eq!(row.requests, 1);
        assert!(row.priced);
        assert_eq!(row.complete_input_tokens.known.as_deref(), Some("12000"));
        assert_eq!(row.cached_input_tokens.known.as_deref(), Some("4000"));
        assert_eq!(row.cache_write_tokens.known, written.map(|n| n.to_string()));
        assert_eq!(row.current_price_requests, 0);
        match written {
            // Each input token belongs to exactly one bucket, not base input plus a write surcharge.
            Some(7000) => { close(row.cost_usd, 0.0229); assert_eq!(row.cost_unknown_requests, 0); }
            Some(0) => { close(row.cost_usd, 0.0194); assert_eq!(row.cost_unknown_requests, 0); }
            None => { close(row.cost_usd, 0.0); assert_eq!(row.cost_unknown_requests, 1); }
            _ => unreachable!(),
        }
    }
}
