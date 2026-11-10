//! Recover only explicitly reported Responses cache writes at the Catalog upgrade boundary.
//! The original receipt supplies evidence; existing ledger rows retain their frozen identity,
//! settlement time and prices. No content hydration, provider calls or receipt replay occurs.
use super::*;

fn responses_family(value: &Value) -> bool {
    matches!(
        value.as_str(),
        Some("openai-responses" | "azure-openai-responses" | "openai-codex-responses")
    )
}

fn missing(value: &Value, field: &str) -> bool {
    value.get(field).is_none_or(Value::is_null)
}

fn recover_receipt(
    tx: &Transaction<'_>,
    table: &str,
    id: &str,
    run_id: &str,
    mut body: Value,
    usage_path: &str,
    attribution_path: &str,
    kind: &str,
) -> Result<()> {
    // SQL and payload identities must agree. Never infer an owner from a model name.
    if body["id"].as_str() != Some(id) || body["run_id"].as_str() != Some(run_id) {
        return Ok(());
    }
    let Some(attribution) = body.pointer(attribution_path).cloned() else {
        return Ok(());
    };
    if !responses_family(&attribution["providerFamily"]) {
        return Ok(());
    }
    let (Some(family), Some(model)) = (
        attribution["providerFamily"].as_str(),
        attribution["model"].as_str(),
    ) else {
        return Ok(());
    };
    if model.is_empty() {
        return Ok(());
    }
    let Some(usage) = body.pointer(usage_path).cloned() else {
        return Ok(());
    };
    if usage["measurement"] != "actual" {
        return Ok(());
    }
    let Some(writes) = usage["raw"]["input_tokens_details"]["cache_write_tokens"].as_u64() else {
        return Ok(());
    };
    // A conflicting known normalization is not evidence for replacing either receipt.
    if !missing(&usage, "cache_write_tokens")
        && usage["cache_write_tokens"].as_u64() != Some(writes)
    {
        return Ok(());
    }

    if missing(&usage, "cache_write_tokens") {
        body.pointer_mut(usage_path).expect("receipt exists")["cache_write_tokens"] = json!(writes);
        tx.execute(
            &format!("UPDATE {table} SET body=?1 WHERE id=?2 AND run_id=?3"),
            params![encode(&body)?, id, run_id],
        )?;
    }

    let record_id = if table == "model_steps" {
        step_record_id(id)
    } else {
        operation_record_id(id)
    };
    let before: Option<String> = tx.query_row(
        "SELECT body FROM usage_records WHERE id=?1 AND run_id=?2 AND provider_family=?3 AND model_id=?4 AND kind=?5 AND (?6 IS NULL OR provider_id=?6)",
        params![record_id, run_id, family, model, kind, attribution["providerId"].as_str()],
        |row| row.get(0),
    ).optional()?;
    let Some(before) = before else { return Ok(()) };
    let mut ledger: Value = serde_json::from_str(&before)?;
    // These owners settle one final request, not an aggregate or a later retry. Contradictory
    // counts must stay unresolved rather than borrowing evidence from a different receipt.
    if ledger["measurement"] != usage["measurement"]
        || !missing(&ledger, "cacheWriteTokens")
        // Responses reports inclusive input. A contradictory derived total must not
        // become a seemingly complete price merely because the write count is restored.
        || ledger["completeInputTokens"] != usage["input_tokens"]
        || [
            ("inputTokens", "input_tokens"),
            ("outputTokens", "output_tokens"),
            ("cachedInputTokens", "cached_input_tokens"),
            ("reasoningTokens", "reasoning_tokens"),
        ]
        .iter()
        .any(|(stored, original)| ledger[*stored] != usage[*original])
    {
        return Ok(());
    }
    ledger["cacheWriteTokens"] = json!(writes);
    tx.execute(
        "UPDATE usage_records SET body=?1 WHERE id=?2 AND body=?3",
        params![encode(&ledger)?, record_id, before],
    )?;
    Ok(())
}

pub(super) fn upgrade_responses_cache_writes(tx: &Transaction<'_>) -> Result<()> {
    let mut steps = tx.prepare(
        "SELECT id,run_id,body FROM model_steps WHERE json_type(body,'$.usage.raw.input_tokens_details.cache_write_tokens')='integer'",
    )?;
    for row in steps.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })? {
        let (id, run_id, before) = row?;
        let body: Value = serde_json::from_str(&before)?;
        let Some(kind @ ("conversation" | "context" | "retrieval")) =
            body["frozen_usage"]["kind"].as_str()
        else {
            continue;
        };
        let kind = kind.to_owned();
        recover_receipt(
            tx,
            "model_steps",
            &id,
            &run_id,
            body,
            "/usage",
            "/frozen_usage/attribution",
            &kind,
        )?;
    }

    // Planning retains the full receipt in control metadata. MCP sampling and auxiliary
    // inference instead keep raw evidence in ContentStore; auxiliary receipts can aggregate
    // retries. Those historical rows are deliberately not guessed from abbreviated counts.
    let mut operations = tx.prepare(
        "SELECT id,run_id,body FROM operations WHERE json_extract(body,'$.intent.kind')='policy_model_job_v1' AND json_type(body,'$.result.value.receipt.usage.raw.input_tokens_details.cache_write_tokens')='integer'",
    )?;
    for row in operations.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })? {
        let (id, run_id, before) = row?;
        let body: Value = serde_json::from_str(&before)?;
        if body["phase"] != "terminal"
            || body["result"]["kind"] != "control"
            || !matches!(
                body["result"]["value"]["receipt"]["dispatch"].as_str(),
                Some("dispatched" | "completed" | "interrupted")
            )
        {
            continue;
        }
        recover_receipt(
            tx,
            "operations",
            &id,
            &run_id,
            body,
            "/result/value/receipt/usage",
            "/result/value/usage_attribution",
            "planning",
        )?;
    }
    Ok(())
}

#[cfg(test)]
#[path = "catalog_usage_recovery_tests.rs"]
mod tests;
