//! Durable request usage. One row per original model request, written in the transaction that
//! makes that request's receipt durable. Rows hold plain identifiers and no foreign keys, so
//! thread deletion, retention and Bot scope removal neither sweep nor block them. The price
//! snapshot is the Host's, frozen with the request; cost is derived only when reading.
use super::usage::{Counter, UsageTokenCount};
use super::*;
use crate::execution::{
    RequestBinding, RequestOrigin, RequestView, UsageMeasurement, UsageReceipt,
};
use crate::types::ModelSessionConfiguration;
use serde::Deserialize;
use std::collections::{BTreeMap, BTreeSet};

#[path = "catalog_usage_recovery.rs"]
mod recovery;

pub(super) fn upgrade_responses_cache_writes(tx: &Transaction<'_>) -> Result<()> {
    recovery::upgrade_responses_cache_writes(tx)
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum PricingCurrency {
    #[serde(rename = "USD")]
    Usd,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum UsageBilling {
    Metered,
    Subscription,
    Local,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum PriceSource {
    Directory,
    Custom,
}
/// Host price snapshot in USD per million tokens. An absent price is unknown, never zero.
/// Attribution only: it never takes part in model, connection or request identity.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", try_from = "UsagePricingWire")]
pub struct UsagePricing {
    pub currency: PricingCurrency,
    pub billing: UsageBilling,
    pub source: PriceSource,
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_per_million: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_per_million: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_read_per_million: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_write_per_million: Option<f64>,
    /// An explicit reasoning rate replaces the output rate for that known subset.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_per_million: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub long_context: Option<UsageLongContextPricing>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_tiers: Option<Vec<UsageLongContextPricing>>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageLongContextPricing {
    pub above_input_tokens: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_per_million: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_per_million: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read_per_million: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write_per_million: Option<f64>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UsagePricingWire {
    currency: PricingCurrency,
    billing: UsageBilling,
    source: PriceSource,
    version: String,
    input_per_million: Option<f64>,
    output_per_million: Option<f64>,
    cache_read_per_million: Option<f64>,
    cache_write_per_million: Option<f64>,
    reasoning_per_million: Option<f64>,
    long_context: Option<UsageLongContextPricing>,
    context_tiers: Option<Vec<UsageLongContextPricing>>,
}
impl TryFrom<UsagePricingWire> for UsagePricing {
    type Error = String;
    fn try_from(w: UsagePricingWire) -> std::result::Result<Self, String> {
        let check = |name: &str, value: Option<f64>| match value {
            Some(price) if !price.is_finite() || price < 0.0 => Err(format!(
                "pricing {name} must be a finite, non-negative USD amount"
            )),
            _ => Ok(()),
        };
        check("inputPerMillion", w.input_per_million)?;
        check("outputPerMillion", w.output_per_million)?;
        check("cacheReadPerMillion", w.cache_read_per_million)?;
        check("cacheWritePerMillion", w.cache_write_per_million)?;
        check("reasoningPerMillion", w.reasoning_per_million)?;
        let mut thresholds = BTreeSet::new();
        for tier in w
            .long_context
            .iter()
            .chain(w.context_tiers.iter().flatten())
        {
            if tier.above_input_tokens == 0 {
                return Err(
                    "pricing longContext.aboveInputTokens must be a positive integer".into(),
                );
            }
            if !thresholds.insert(tier.above_input_tokens) {
                return Err("duplicate context price threshold".into());
            }
            check("longContext.inputPerMillion", tier.input_per_million)?;
            check("longContext.outputPerMillion", tier.output_per_million)?;
            check(
                "longContext.cacheReadPerMillion",
                tier.cache_read_per_million,
            )?;
            check(
                "longContext.cacheWritePerMillion",
                tier.cache_write_per_million,
            )?;
        }
        Ok(Self {
            currency: w.currency,
            billing: w.billing,
            source: w.source,
            version: w.version,
            input_per_million: w.input_per_million,
            output_per_million: w.output_per_million,
            cache_read_per_million: w.cache_read_per_million,
            cache_write_per_million: w.cache_write_per_million,
            reasoning_per_million: w.reasoning_per_million,
            long_context: w.long_context,
            context_tiers: w.context_tiers,
        })
    }
}

impl ModelSessionConfiguration {
    /// Equality for every execution identity check: a changed price snapshot alone never
    /// rebinds, rejects inherited work or splits a connection.
    pub fn same_identity(&self, other: &Self) -> bool {
        self == other || {
            let (mut a, mut b) = (self.clone(), other.clone());
            a.pricing = None;
            b.pricing = None;
            a == b
        }
    }
}
/// A stored model configuration without its price snapshot, for identity checks and hashes.
pub fn configuration_identity(value: &Value) -> std::borrow::Cow<'_, Value> {
    match value {
        Value::Object(map) if map.contains_key("pricing") => {
            let mut map = map.clone();
            map.remove("pricing");
            std::borrow::Cow::Owned(Value::Object(map))
        }
        _ => std::borrow::Cow::Borrowed(value),
    }
}
/// Stored-configuration counterpart of [`ModelSessionConfiguration::same_identity`].
pub fn same_configuration(a: &Value, b: &Value) -> bool {
    configuration_identity(a) == configuration_identity(b)
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum UsageKind {
    Conversation,
    Context,
    Retrieval,
    Planning,
    McpSampling,
    Auxiliary,
}
impl UsageKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Conversation => "conversation",
            Self::Context => "context",
            Self::Retrieval => "retrieval",
            Self::Planning => "planning",
            Self::McpSampling => "mcp_sampling",
            Self::Auxiliary => "auxiliary",
        }
    }
}
/// Channel and price frozen with the original request.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageAttribution {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_family: Option<String>,
    pub model: String,
    /// Used only to recover the original Run's channel for bindings without a provider.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub connection_identity: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pricing: Option<UsagePricing>,
}
impl UsageAttribution {
    pub fn of_binding(binding: &RequestBinding) -> Self {
        Self {
            provider_id: binding.provider_id.clone(),
            provider_family: Some(binding.provider_family.clone()),
            model: binding.model.clone(),
            connection_identity: binding.connection_identity.clone(),
            pricing: binding.pricing.clone(),
        }
    }
}
/// Ledger identity of a dispatched native ModelStep, frozen when it dispatches so the
/// interruption and restart paths settle it without reading request content.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FrozenUsage {
    pub kind: UsageKind,
    pub attribution: UsageAttribution,
}
/// Conversation request metadata taken from the frozen snapshot. Auxiliary, sampling and
/// policy origins keep their own Operation receipts, so a mirrored ModelStep has none.
pub(super) struct FrozenRequest {
    compaction: bool,
    attribution: UsageAttribution,
}
pub(super) fn frozen_request<M>(view: &RequestView<M>) -> Option<FrozenRequest> {
    match &view.origin {
        RequestOrigin::Driver { .. } => Some(FrozenRequest { compaction: false, attribution: UsageAttribution::of_binding(&view.binding) }),
        RequestOrigin::Conversation { compaction, .. } => Some(FrozenRequest {
            compaction: compaction.is_some(),
            attribution: UsageAttribution::of_binding(&view.binding),
        }),
        _ => None,
    }
}
pub(super) fn step_usage(
    db: &Connection,
    run: &Run,
    frozen: &FrozenRequest,
) -> Result<FrozenUsage> {
    let retrieval: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM child_tasks c JOIN operations o ON o.id=c.id WHERE c.child_thread_id=?1 AND json_extract(o.body,'$.executor')='code_retrieval')",
        [&run.thread_id],
        |row| row.get(0),
    )?;
    let kind = if frozen.compaction {
        UsageKind::Context
    } else if retrieval {
        UsageKind::Retrieval
    } else {
        UsageKind::Conversation
    };
    Ok(FrozenUsage {
        kind,
        attribution: frozen.attribution.clone(),
    })
}
pub(super) fn step_record_id(request_id: &str) -> String {
    format!("model_step:{request_id}")
}
/// Each native attempt is its own ModelStep and request; its first durable receipt is final.
pub(super) fn record_step(
    db: &Transaction<'_>,
    step: &ModelStep,
    frozen: &FrozenUsage,
    usage: &UsageReceipt,
) -> Result<()> {
    record(
        db,
        UsageEntry {
            id: step_record_id(&step.id),
            kind: frozen.kind,
            purpose: None,
            run_id: &step.run_id,
            attribution: &frozen.attribution,
            usage,
        },
        Settlement::Final,
    )
}
pub(super) fn operation_record_id(operation_id: &str) -> String {
    format!("operation:{operation_id}")
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct RecordBody {
    measurement: UsageMeasurement,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    cached_input_tokens: Option<u64>,
    cache_write_tokens: Option<u64>,
    reasoning_tokens: Option<u64>,
    complete_input_tokens: Option<u64>,
    #[serde(default)]
    reasoning_in_output: Option<bool>,
    pricing: Option<UsagePricing>,
}
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Settlement {
    /// The first durable receipt is final; a replay leaves the row unchanged.
    Final,
    /// A later receipt may refine unknown counts of the same original request.
    Refinable,
}
pub(super) struct UsageEntry<'a> {
    pub id: String,
    pub kind: UsageKind,
    pub purpose: Option<&'a str>,
    pub run_id: &'a str,
    pub attribution: &'a UsageAttribution,
    pub usage: &'a UsageReceipt,
}
/// Call inside the transaction that makes the request's receipt durable.
pub(super) fn record(
    db: &Transaction<'_>,
    entry: UsageEntry<'_>,
    settlement: Settlement,
) -> Result<()> {
    let (branch_id, thread_id): (Option<String>, Option<String>) = db
        .query_row(
            "SELECT r.branch_id,b.thread_id FROM runs r LEFT JOIN branches b ON b.id=r.branch_id WHERE r.id=?1",
            [entry.run_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?
        .unwrap_or_default();
    let owner = thread_id
        .as_deref()
        .map(|thread| owner_thread(db, thread))
        .transpose()?
        .flatten();
    let attribution = entry.attribution;
    let provider_id = match &attribution.provider_id {
        Some(provider) => Some(provider.clone()),
        None if !attribution.connection_identity.is_empty() => db
            .query_row(
                "SELECT json_extract(r.body,'$.configuration.providerId') FROM runs r JOIN run_launches l ON l.id=r.id WHERE r.id=?1 AND json_extract(l.body,'$.selection.connection_identity')=?2 AND json_extract(l.body,'$.selection.provider_family')=?3 AND json_extract(l.body,'$.selection.model')=?4",
                params![entry.run_id, attribution.connection_identity, attribution.provider_family, attribution.model],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten(),
        None => None,
    };
    let usage = entry.usage;
    let embedding = entry
        .purpose
        .is_some_and(|purpose| purpose.ends_with("-embedding"));
    let body = RecordBody {
        measurement: usage.measurement,
        input_tokens: usage.input_tokens,
        // Embedding produces vectors, not generated text tokens. This does not
        // rewrite the provider's original receipt or estimate its input count.
        output_tokens: usage.output_tokens.or_else(|| embedding.then_some(0)),
        cached_input_tokens: usage.cached_input_tokens,
        cache_write_tokens: usage.cache_write_tokens,
        reasoning_tokens: usage.reasoning_tokens,
        reasoning_in_output: match attribution.provider_family.as_deref() {
            Some(
                "openai-completions"
                | "openai-responses"
                | "openai-codex-responses"
                | "azure-openai-responses"
                | "google-generative-ai"
                | "google-vertex",
            ) => Some(true),
            _ => None,
        },
        complete_input_tokens: attribution
            .provider_family
            .as_deref()
            .and_then(|family| crate::providers::reported_input_tokens(family, usage))
            .or_else(|| if embedding { usage.input_tokens } else { None }),
        pricing: attribution.pricing.clone(),
    };
    let conflict = match settlement {
        Settlement::Final => "DO NOTHING",
        Settlement::Refinable => "DO UPDATE SET body=excluded.body",
    };
    let changed = db.execute(
        &format!("INSERT INTO usage_records(id,at_ms,kind,purpose,owner_thread_id,thread_id,branch_id,run_id,provider_id,provider_family,model_id,body) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12) ON CONFLICT(id) {conflict}"),
        params![entry.id, sql_number(threads::now_ms()?)?, entry.kind.as_str(), entry.purpose, owner, thread_id, branch_id,
            entry.run_id, provider_id, attribution.provider_family, attribution.model, encode(&body)?],
    )?;
    if changed > 0 {
        event(db, &entry.id, 0, "usage.updated", json!({}))?;
    }
    Ok(())
}
/// Only for a refined receipt that proves the original request never entered its transport.
pub(super) fn retract(db: &Transaction<'_>, id: &str) -> Result<()> {
    let exists: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM usage_records WHERE id=?1)", [id], |row| row.get(0))?;
    if exists {
        // Publish before deleting the ownership row, in the same transaction.
        event(db, id, 0, "usage.updated", json!({}))?;
        db.execute("DELETE FROM usage_records WHERE id=?1", [id])?;
    }
    Ok(())
}
/// The user-visible conversation that caused the work. Host memory maintenance has none.
fn owner_thread(db: &Connection, thread: &str) -> Result<Option<String>> {
    let mut current = thread.to_owned();
    let mut visited = std::collections::HashSet::new();
    loop {
        if !visited.insert(current.clone()) {
            return Err(RuntimeError::Conflict(
                "usage ownership contains a cycle".into(),
            ));
        }
        let maintenance: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM branches b JOIN runs r ON r.branch_id=b.id JOIN operations o ON o.run_id=r.id WHERE b.thread_id=?1 AND json_extract(o.body,'$.intent.kind')='memory_work_v1')",
            [&current],
            |row| row.get(0),
        )?;
        if maintenance {
            return Ok(None);
        }
        let parent: Option<String> = db
            .query_row(
                "SELECT json_extract(body,'$.parent_thread_id') FROM child_tasks WHERE child_thread_id=?1",
                [&current],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        let parent = match parent {
            Some(parent) => Some(parent),
            None => db
                .query_row(
                    "SELECT s.thread_id FROM branches h JOIN runs r ON r.branch_id=h.id JOIN context_jobs j ON j.run_id=r.id JOIN branches s ON s.id=j.branch_id WHERE h.thread_id=?1 AND s.thread_id!=?1 LIMIT 1",
                    [&current],
                    |row| row.get(0),
                )
                .optional()?,
        };
        match parent {
            Some(parent) if parent != current => current = parent,
            _ => break,
        }
    }
    Ok(Some(current))
}

pub(super) fn initialize(tx: &Transaction<'_>) -> Result<()> {
    tx.execute_batch("CREATE TABLE usage_records(id TEXT PRIMARY KEY,at_ms INTEGER NOT NULL,kind TEXT NOT NULL,purpose TEXT,owner_thread_id TEXT,thread_id TEXT,branch_id TEXT,run_id TEXT,provider_id TEXT,provider_family TEXT,model_id TEXT NOT NULL,body TEXT NOT NULL);
        CREATE INDEX usage_records_at ON usage_records(at_ms);
        CREATE INDEX usage_external_at ON external_turns(json_extract(body,'$.updatedAt'));
        CREATE TABLE usage_ledger(id INTEGER PRIMARY KEY CHECK(id=1),recording_started_at_ms INTEGER NOT NULL CHECK(recording_started_at_ms>=0));")?;
    tx.execute(
        "INSERT INTO usage_ledger(id,recording_started_at_ms) VALUES(1,?1)",
        [sql_number(threads::now_ms()?)?],
    )?;
    Ok(())
}
pub(super) fn check_format(db: &Connection) -> Result<()> {
    db.prepare("SELECT id,at_ms,kind,purpose,owner_thread_id,thread_id,branch_id,run_id,provider_id,provider_family,model_id,body FROM usage_records")?;
    let started: Option<i64> = db
        .query_row(
            "SELECT recording_started_at_ms FROM usage_ledger WHERE id=1",
            [],
            |row| row.get(0),
        )
        .optional()?;
    if started.is_none() {
        return Err(RuntimeError::Invalid(
            "usage ledger start is missing; data was preserved".into(),
        ));
    }
    Ok(())
}

const DAY_MS: i64 = 86_400_000;
/// Real civil offsets span UTC-12:00 to UTC+14:00.
const MAX_OFFSET_MINUTES: i64 = 14 * 60;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageSummaryParams {
    pub from_ms: u64,
    pub to_ms: u64,
    pub utc_offset_minutes: i64,
    #[serde(default)]
    pub days: Vec<UsageDay>,
    #[serde(default)]
    pub current_prices: Vec<UsageCurrentPrice>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageDay {
    pub day: String,
    pub from_ms: u64,
    pub to_ms: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageCurrentPrice {
    pub provider_id: String,
    pub model_id: String,
    pub pricing: UsagePricing,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummaryRow {
    pub day: String,
    pub kind: String,
    pub purpose: Option<String>,
    pub provider_id: Option<String>,
    pub provider_family: Option<String>,
    pub model_id: String,
    pub billing: Option<UsageBilling>,
    pub priced: bool,
    pub price_sources: Vec<PriceSource>,
    pub measurement: UsageMeasurement,
    pub requests: u64,
    pub input_tokens: UsageTokenCount,
    pub output_tokens: UsageTokenCount,
    pub cached_input_tokens: UsageTokenCount,
    pub cache_write_tokens: UsageTokenCount,
    pub reasoning_tokens: UsageTokenCount,
    pub complete_input_tokens: UsageTokenCount,
    pub cost_usd: f64,
    pub cost_unknown_requests: u64,
    pub cache_saved_usd: f64,
    pub reference_usd: f64,
    pub current_price_requests: u64,
    pub prices: Vec<UsagePricing>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummaryThread {
    pub day: String,
    pub thread_id: String,
    pub title: Option<String>,
    pub deleted: bool,
    pub requests: u64,
    pub tokens: UsageTokenCount,
    pub cost_usd: f64,
    pub cost_unknown_requests: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    pub through_cursor: u64,
    pub recording_started_at_ms: Option<u64>,
    pub rows: Vec<UsageSummaryRow>,
    pub threads: Vec<UsageSummaryThread>,
    pub external: Vec<Value>,
}
struct CapturedRecord {
    at_ms: i64,
    kind: String,
    purpose: Option<String>,
    owner: Option<(String, Option<String>)>,
    provider_id: Option<String>,
    provider_family: Option<String>,
    model_id: String,
    body: String,
}
pub struct UsageSummaryRead {
    offset_minutes: i64,
    cursor: u64,
    started: Option<u64>,
    records: Vec<CapturedRecord>,
    days: Vec<UsageDay>,
    current_prices: Vec<UsageCurrentPrice>,
    external: Vec<Value>,
}
impl Catalog {
    /// One indexed range read under Catalog ownership; parsing and pricing happen after release.
    pub fn capture_usage_summary(&self, params: &UsageSummaryParams) -> Result<UsageSummaryRead> {
        if params.to_ms <= params.from_ms {
            return Err(RuntimeError::Invalid(
                "usage range end must follow its start".into(),
            ));
        }
        if params.utc_offset_minutes.unsigned_abs() > MAX_OFFSET_MINUTES as u64 {
            return Err(RuntimeError::Invalid("UTC offset exceeds 14 hours".into()));
        }
        if !params.days.is_empty() {
            let mut edge = params.from_ms;
            for day in &params.days {
                if day.from_ms != edge || day.to_ms <= day.from_ms || day.to_ms > params.to_ms {
                    return Err(RuntimeError::Invalid(
                        "local calendar days must cover the selected range in order".into(),
                    ));
                }
                edge = day.to_ms;
            }
            if edge != params.to_ms {
                return Err(RuntimeError::Invalid(
                    "local calendar days do not cover the selected range".into(),
                ));
            }
        }
        let mut statement = self.db.prepare("SELECT u.at_ms,u.kind,u.purpose,u.owner_thread_id,CASE WHEN t.deleted_at_ms IS NULL THEN t.title END,u.provider_id,u.provider_family,u.model_id,u.body FROM usage_records u LEFT JOIN threads t ON t.id=u.owner_thread_id WHERE u.at_ms>=?1 AND u.at_ms<?2 ORDER BY u.at_ms,u.id")?;
        let records = statement
            .query_map(
                params![sql_number(params.from_ms)?, sql_number(params.to_ms)?],
                |row| {
                    let owner: Option<String> = row.get(3)?;
                    Ok(CapturedRecord {
                        at_ms: row.get(0)?,
                        kind: row.get(1)?,
                        purpose: row.get(2)?,
                        owner: owner
                            .map(|id| row.get::<_, Option<String>>(4).map(|title| (id, title)))
                            .transpose()?,
                        provider_id: row.get(5)?,
                        provider_family: row.get(6)?,
                        model_id: row.get(7)?,
                        body: row.get(8)?,
                    })
                },
            )?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let started = self
            .db
            .query_row(
                "SELECT recording_started_at_ms FROM usage_ledger WHERE id=1",
                [],
                |row| read_number(row, 0),
            )
            .optional()?;
        let mut external_query = self.db.prepare("SELECT json_object('harness',json_extract(c.body,'$.harness'),'conversationId',t.conversation_id,'turnId',t.id,'atMs',json_extract(t.body,'$.updatedAt'),'status',json_extract(t.body,'$.status'),'usage',json_extract(t.body,'$.usage')) FROM external_turns t JOIN external_conversations c ON c.id=t.conversation_id WHERE json_extract(t.body,'$.updatedAt')>=?1 AND json_extract(t.body,'$.updatedAt')<?2")?;
        let external = external_query
            .query_map(
                params![sql_number(params.from_ms)?, sql_number(params.to_ms)?],
                |row| row.get::<_, String>(0),
            )?
            .map(|row| Ok(serde_json::from_str(&row?)?))
            .collect::<Result<Vec<_>>>()?;
        Ok(UsageSummaryRead {
            offset_minutes: params.utc_offset_minutes,
            cursor: self.event_cursor()?,
            started,
            records,
            days: params.days.clone(),
            current_prices: params.current_prices.clone(),
            external,
        })
    }
}

/// Cost of one request. Unpriced (no snapshot, local billing, or no input/output price) is
/// distinct from Unknown (priced, but the reported counts cannot determine the amount).
#[derive(Debug, Clone, Copy, PartialEq)]
enum Cost {
    Unpriced { local: bool },
    Unknown,
    Known(f64),
}
#[derive(Debug, Clone, Copy, PartialEq)]
struct Charge {
    cost: Cost,
    cache_saved: Option<f64>,
}
fn charge(body: &RecordBody) -> Charge {
    let unpriced = |local| Charge {
        cost: Cost::Unpriced { local },
        cache_saved: None,
    };
    let Some(pricing) = &body.pricing else {
        return unpriced(false);
    };
    if pricing.billing == UsageBilling::Local {
        return unpriced(true);
    }
    let (Some(input), Some(output)) = (
        pricing.input_per_million,
        pricing
            .output_per_million
            .or_else(|| (body.output_tokens == Some(0)).then_some(0.0)),
    ) else {
        return unpriced(false);
    };
    let complete = body.complete_input_tokens;
    // Without complete input the tier is unknown, and so is every derived amount.
    let tier = if pricing.long_context.is_none()
        && pricing.context_tiers.as_ref().is_none_or(Vec::is_empty)
    {
        Some(None)
    } else {
        complete.map(|tokens| {
            pricing
                .long_context
                .iter()
                .chain(pricing.context_tiers.iter().flatten())
                .filter(|tier| tokens > tier.above_input_tokens)
                .max_by_key(|tier| tier.above_input_tokens)
        })
    };
    let Some(tier) = tier else {
        return Charge {
            cost: Cost::Unknown,
            cache_saved: None,
        };
    };
    let input = tier
        .and_then(|tier| tier.input_per_million)
        .unwrap_or(input);
    let output = tier
        .and_then(|tier| tier.output_per_million)
        .unwrap_or(output);
    let read_price = tier
        .and_then(|tier| tier.cache_read_per_million)
        .or(pricing.cache_read_per_million);
    let write_price = tier
        .and_then(|tier| tier.cache_write_per_million)
        .or(pricing.cache_write_per_million);
    let cache_saved = body
        .cached_input_tokens
        .zip(read_price)
        .map(|(tokens, read)| tokens as f64 * (input - read) / 1_000_000.0);
    // An unreported cache bucket is harmless only when it is billed exactly like input.
    let bucket = |tokens: Option<u64>, price: Option<f64>| match tokens {
        Some(tokens) => Some(tokens),
        None if price.is_some_and(|price| price != input) => None,
        None => Some(0),
    };
    let amount = (|| {
        let read = bucket(body.cached_input_tokens, read_price)?;
        let write = bucket(body.cache_write_tokens, write_price)?;
        let uncached = complete?.checked_sub(read)?.checked_sub(write)?;
        let generated = body.output_tokens?;
        let output_cost = if let Some(rate) = pricing
            .reasoning_per_million
            .filter(|rate| *rate != output)
        {
            let reasoning = body.reasoning_tokens?;
            if reasoning == 0 {
                generated as f64 * output
            } else {
                let ordinary = match body.reasoning_in_output {
                    Some(true) => generated.checked_sub(reasoning)?,
                    Some(false) => generated,
                    None => return None,
                };
                ordinary as f64 * output + reasoning as f64 * rate
            }
        } else {
            generated as f64 * output
        };
        Some(
            (uncached as f64 * input
                + read as f64 * read_price.unwrap_or(input)
                + write as f64 * write_price.unwrap_or(input)
                + output_cost)
                / 1_000_000.0,
        )
    })();
    Charge {
        cost: amount.map_or(Cost::Unknown, Cost::Known),
        cache_saved,
    }
}
/// Proleptic Gregorian date of a day count since 1970-01-01.
fn civil_day(days: i64) -> String {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}
fn local_day(at_ms: i64, offset_minutes: i64) -> String {
    civil_day((at_ms + offset_minutes * 60_000).div_euclid(DAY_MS))
}
#[derive(Default)]
struct RowAggregate {
    price_sources: BTreeSet<PriceSource>,
    requests: u64,
    tokens: [Counter; 6],
    cost_usd: f64,
    cost_unknown: u64,
    cache_saved_usd: f64,
    reference_usd: f64,
    current_price_requests: u64,
    prices: Vec<UsagePricing>,
}
#[derive(Default)]
struct ThreadAggregate {
    title: Option<String>,
    deleted: bool,
    requests: u64,
    tokens: Counter,
    cost_usd: f64,
    cost_unknown: u64,
}
type RowKey = (
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    String,
    Option<UsageBilling>,
    bool,
    String,
);
impl UsageSummaryRead {
    pub fn load(self, cancelled: &dyn Fn() -> bool) -> Result<UsageSummary> {
        let mut rows: BTreeMap<RowKey, (UsageMeasurement, RowAggregate)> = BTreeMap::new();
        let mut threads: BTreeMap<(String, String), ThreadAggregate> = BTreeMap::new();
        for (index, record) in self.records.into_iter().enumerate() {
            if index % 256 == 0 && cancelled() {
                return Err(RuntimeError::DispatchCancelled);
            }
            let mut body: RecordBody = serde_json::from_str(&record.body)?;
            let mut current_price = false;
            if body.pricing.as_ref().is_none_or(|price| {
                price.input_per_million.is_none() || price.output_per_million.is_none()
            }) {
                if let Some(price) = self.current_prices.iter().find(|price| {
                    Some(&price.provider_id) == record.provider_id.as_ref()
                        && price.model_id == record.model_id
                }) {
                    let mut pricing = price.pricing.clone();
                    if let Some(original) = &body.pricing {
                        pricing.billing = original.billing;
                    }
                    body.pricing = Some(pricing);
                    current_price = true;
                }
            }
            let day = if self.days.is_empty() {
                local_day(record.at_ms, self.offset_minutes)
            } else {
                let index = self
                    .days
                    .partition_point(|day| day.to_ms <= record.at_ms as u64);
                self.days[index].day.clone()
            };
            let charge = charge(&body);
            let billing = body.pricing.as_ref().map(|pricing| pricing.billing);
            let priced = matches!(charge.cost, Cost::Known(_) | Cost::Unknown);
            let key = (
                day.clone(),
                record.kind,
                record.purpose,
                record.provider_id,
                record.provider_family,
                record.model_id,
                billing,
                priced,
                serde_json::to_string(&body.measurement)?,
            );
            let (_, row) = rows
                .entry(key)
                .or_insert_with(|| (body.measurement, RowAggregate::default()));
            row.requests += 1;
            row.price_sources
                .extend(body.pricing.as_ref().map(|pricing| pricing.source));
            if let Some(price) = &body.pricing {
                if !row.prices.contains(price) {
                    row.prices.push(price.clone());
                }
            }
            if current_price && priced {
                row.current_price_requests += 1;
            }
            let counts = [
                body.input_tokens,
                body.output_tokens,
                body.cached_input_tokens,
                body.cache_write_tokens,
                body.reasoning_tokens,
                body.complete_input_tokens,
            ];
            for (counter, value) in row.tokens.iter_mut().zip(counts) {
                counter.add(value)?;
            }
            match charge.cost {
                Cost::Known(usd) if billing == Some(UsageBilling::Subscription) => {
                    row.reference_usd += usd
                }
                Cost::Known(usd) => row.cost_usd += usd,
                Cost::Unknown => row.cost_unknown += 1,
                Cost::Unpriced { .. } => {}
            }
            if priced && billing == Some(UsageBilling::Metered) {
                row.cache_saved_usd += charge.cache_saved.unwrap_or(0.0);
            }
            if let Some((thread_id, title)) = record.owner {
                let thread = threads.entry((day, thread_id)).or_default();
                thread.deleted = title.is_none();
                thread.title = title;
                thread.requests += 1;
                thread
                    .tokens
                    .add_sum(&[body.complete_input_tokens, body.output_tokens])?;
                match charge.cost {
                    Cost::Known(_) if billing == Some(UsageBilling::Subscription) => {}
                    Cost::Known(usd) => thread.cost_usd += usd,
                    Cost::Unknown | Cost::Unpriced { local: false }
                        if billing == Some(UsageBilling::Subscription) => {}
                    Cost::Unknown | Cost::Unpriced { local: false } => thread.cost_unknown += 1,
                    Cost::Unpriced { local: true } => {}
                }
            }
        }
        if cancelled() {
            return Err(RuntimeError::DispatchCancelled);
        }
        let rows = rows
            .into_iter()
            .map(
                |(
                    (
                        day,
                        kind,
                        purpose,
                        provider_id,
                        provider_family,
                        model_id,
                        billing,
                        priced,
                        _,
                    ),
                    (measurement, row),
                )| {
                    let [input, output, cached, write, reasoning, complete] = row.tokens;
                    UsageSummaryRow {
                        day,
                        kind,
                        purpose,
                        provider_id,
                        provider_family,
                        model_id,
                        billing,
                        priced,
                        price_sources: row.price_sources.into_iter().collect(),
                        measurement,
                        requests: row.requests,
                        input_tokens: input.finish(),
                        output_tokens: output.finish(),
                        cached_input_tokens: cached.finish(),
                        cache_write_tokens: write.finish(),
                        reasoning_tokens: reasoning.finish(),
                        complete_input_tokens: complete.finish(),
                        cost_usd: row.cost_usd,
                        cost_unknown_requests: row.cost_unknown,
                        cache_saved_usd: row.cache_saved_usd,
                        reference_usd: row.reference_usd,
                        current_price_requests: row.current_price_requests,
                        prices: row.prices,
                    }
                },
            )
            .collect();
        let threads = threads
            .into_iter()
            .map(|((day, thread_id), thread)| UsageSummaryThread {
                day,
                thread_id,
                title: thread.title,
                deleted: thread.deleted,
                requests: thread.requests,
                tokens: thread.tokens.finish(),
                cost_usd: thread.cost_usd,
                cost_unknown_requests: thread.cost_unknown,
            })
            .collect();
        Ok(UsageSummary {
            through_cursor: self.cursor,
            recording_started_at_ms: self.started,
            rows,
            threads,
            external: self.external,
        })
    }
}

#[cfg(test)]
#[path = "catalog_usage_ledger_tests.rs"]
mod tests;

#[cfg(test)]
pub(crate) mod fixture {
    use super::*;
    use crate::execution::*;
    /// One dispatched, completed native conversation request on the Run's branch, through the
    /// production commit path, then the Run's completion.
    pub(crate) fn completed_conversation(db: &mut Catalog, run_id: &str, request_id: &str) {
        let epoch = db.epoch();
        if db.run(run_id).unwrap().state == RunState::Accepted {
            db.commit_execution(
                run_id,
                epoch,
                &ExecutionRecord::StateChanged {
                    state: RunState::Runnable,
                    waiting_on: None,
                },
            )
            .unwrap();
        }
        let run = db.run(run_id).unwrap();
        let range = HistoryRange {
            branch_id: run.branch_id.clone(),
            ancestor_id: None,
            leaf_id: db.head(&run.branch_id).unwrap(),
        };
        let binding: RequestBinding = serde_json::from_value(json!({"provider_id":"channel","provider_family":"openai-responses","model":"fixture-model",
            "pricing":{"currency":"USD","billing":"metered","source":"directory","version":"fixture","inputPerMillion":1.0,"outputPerMillion":2.0},
            "resource_activations":[],"resource_checkpoint_id":null,"connection_identity":"fixture","credential_ref":null,"configuration_generation":1,
            "tool_schema_generation":0,"tools":[],"instruction_sources":[],"memory_checkpoint":null,"attachment_refs":[],"environment_cursor":0,"history_range":range})).unwrap();
        let snapshot = RequestSnapshot {
            view: RequestView {
                request_id: request_id.into(),
                run_id: run_id.into(),
                origin: RequestOrigin::Conversation {
                    compaction: None,
                    step: 0,
                    history_range: range,
                },
                binding,
                history: vec![],
            },
            serialized: json!({}).into(),
        };
        let usage = UsageReceipt {
            measurement: UsageMeasurement::Actual,
            input_tokens: Some(1_000),
            output_tokens: Some(100),
            ..Default::default()
        };
        for record in [
            ExecutionRecord::RequestPrepared {
                snapshot: snapshot.into(),
            },
            ExecutionRecord::ModelDispatched {
                request_id: request_id.into(),
            },
            ExecutionRecord::ModelFinished {
                request_id: request_id.into(),
                outcome: ModelOutcome::Completed,
                finish_reason: Some(FinishReason::Stop),
                items: vec![],
                interrupted_deltas: vec![],
                usage,
                failure: None,
            },
        ] {
            db.commit_execution(run_id, epoch, &record).unwrap();
        }
        let revision = db.run(run_id).unwrap().revision;
        db.transition_run(run_id, epoch, revision, RunState::Completed)
            .unwrap();
    }
    pub(crate) fn summary(db: &Catalog) -> UsageSummary {
        let now = threads::now_ms().unwrap();
        db.capture_usage_summary(&UsageSummaryParams {
            from_ms: now - DAY_MS as u64,
            to_ms: now + DAY_MS as u64,
            utc_offset_minutes: 0,
            days: vec![],
            current_prices: vec![],
        })
        .unwrap()
        .load(&|| false)
        .unwrap()
    }
}
