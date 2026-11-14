//! Request-owned presentation metrics. Provider usage stays the billing authority.
use crate::execution::{ProviderEvent, UsageMeasurement, UsageReceipt};
use crate::token_count::TokenCounter;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::time::Instant;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GenerationMetrics {
    pub started_at_ms: u64,
    pub elapsed_ms: u64,
    pub first_output_ms: Option<u64>,
    pub last_output_ms: Option<u64>,
    pub output_tokens: u64,
    pub measurement: UsageMeasurement,
    pub recent_tokens: u64,
    pub recent_ms: u64,
    pub finished: bool,
}

pub(crate) struct GenerationMeter {
    started: Instant,
    counter: TokenCounter,
    pending: String,
    samples: VecDeque<(u64, u64)>,
    sampled_at: u64,
    metrics: GenerationMetrics,
}

impl GenerationMeter {
    pub fn new(counter: TokenCounter) -> Self {
        Self {
            started: Instant::now(),
            counter,
            pending: String::new(),
            samples: VecDeque::new(),
            sampled_at: 0,
            metrics: GenerationMetrics {
                started_at_ms: crate::catalog::observations::wall_time_ms().unwrap_or(0),
                elapsed_ms: 0,
                first_output_ms: None,
                last_output_ms: None,
                output_tokens: 0,
                measurement: UsageMeasurement::Estimated,
                recent_tokens: 0,
                recent_ms: 0,
                finished: false,
            },
        }
    }

    pub fn observe(&mut self, event: &ProviderEvent) -> Option<GenerationMetrics> {
        self.observe_at(event, self.started.elapsed().as_millis() as u64)
    }

    fn observe_at(&mut self, event: &ProviderEvent, elapsed: u64) -> Option<GenerationMetrics> {
        let text = match event {
            ProviderEvent::TextDelta { text, .. } | ProviderEvent::ReasoningDelta { text, .. } => {
                text
            }
            ProviderEvent::ToolArgumentsDelta { delta, .. } => delta,
            _ => return None,
        };
        if text.is_empty() {
            return None;
        }
        let first = self.metrics.first_output_ms.is_none();
        self.metrics.first_output_ms.get_or_insert(elapsed);
        self.metrics.last_output_ms = Some(elapsed);
        self.pending.push_str(text);
        // Tokenize only newly received content, in batches. Chunk-boundary counts are
        // estimates; final provider usage replaces them without rewriting any receipt.
        if first || elapsed.saturating_sub(self.sampled_at) >= 500 {
            self.sample(elapsed);
            Some(self.metrics.clone())
        } else {
            None
        }
    }

    fn sample(&mut self, elapsed: u64) {
        let count = if self.pending.is_empty() {
            0
        } else {
            self.counter.count(&self.pending)
        };
        self.pending.clear();
        self.metrics.output_tokens += count;
        self.samples.push_back((elapsed, count));
        while self
            .samples
            .front()
            .is_some_and(|(at, _)| elapsed.saturating_sub(*at) > 2000)
        {
            self.samples.pop_front();
        }
        self.sampled_at = elapsed;
        self.metrics.elapsed_ms = elapsed;
        self.metrics.recent_tokens = self.samples.iter().map(|(_, count)| count).sum();
        self.metrics.recent_ms = elapsed.min(2000);
    }

    pub fn finish(self, usage: &UsageReceipt) -> GenerationMetrics {
        let elapsed = self.started.elapsed().as_millis() as u64;
        self.finish_at(usage, elapsed)
    }

    fn finish_at(mut self, usage: &UsageReceipt, elapsed: u64) -> GenerationMetrics {
        self.sample(elapsed);
        if let Some(tokens) = usage.output_tokens {
            self.metrics.output_tokens = tokens;
            self.metrics.measurement = usage.measurement;
        }
        self.metrics.finished = true;
        self.metrics
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn request_clock_and_new_content_counts_survive_batching_and_final_usage() {
        let mut meter = GenerationMeter::new(TokenCounter::for_model("gpt-4o"));
        let text = |value: &str| ProviderEvent::TextDelta {
            item_id: "answer".into(),
            text: value.into(),
        };
        let first = meter.observe_at(&text("Hello"), 800).unwrap();
        assert_eq!(first.first_output_ms, Some(800));
        assert!(first.output_tokens > 0);
        assert!(meter.observe_at(&text(" world"), 950).is_none());
        let next = meter.observe_at(&text("!"), 1400).unwrap();
        assert!(next.output_tokens > first.output_tokens);
        assert_eq!(next.first_output_ms, Some(800));
        assert_eq!(next.last_output_ms, Some(1400));
        let final_metrics = meter.finish_at(
            &UsageReceipt {
                measurement: UsageMeasurement::Actual,
                output_tokens: Some(42),
                ..Default::default()
            },
            2000,
        );
        assert_eq!(final_metrics.output_tokens, 42);
        assert_eq!(final_metrics.elapsed_ms, 2000);
        assert_eq!(final_metrics.measurement, UsageMeasurement::Actual);
        assert!(final_metrics.finished);
    }
}
