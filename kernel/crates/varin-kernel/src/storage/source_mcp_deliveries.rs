//! Compact reverse-interaction transport facts owned by the original Source.
//! This is neither an Agent interaction owner nor a durable SDK responder.
use super::*;
use crate::source_resources::*;
use varin_runtime::catalog::mcp_interactions::{
    McpInteractionBinding, McpInteractionRelation, McpInteractionSource, McpRequestId,
};
use varin_runtime::McpInteractionAvailability as Availability;

fn sha256(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn request_id(id: &McpRequestId) -> bool {
    match id {
        McpRequestId::String(id) => !id.is_empty(),
        McpRequestId::Number(_) => true,
    }
}
fn binding_valid(binding: &McpInteractionBinding) -> bool {
    !binding.operation_id.is_empty()
        && !binding.connection_id.is_empty()
        && matches!(
            binding.execution_owner,
            varin_runtime::ExecutorOwner::External { .. }
        )
        && binding.execution_owner.validate()
        && !binding.endpoint.server.is_empty()
        && !binding.endpoint.resource_key.is_empty()
        && !binding.endpoint.configuration_version.is_empty()
        && !binding.endpoint.credential_version.is_empty()
        && match &binding.source {
            McpInteractionSource::ServerRequest {
                request_id: id,
                relation,
            } => {
                request_id(id)
                    && match relation {
                        McpInteractionRelation::RpcResponseStream {
                            outgoing_request_id,
                        } => request_id(outgoing_request_id),
                        McpInteractionRelation::Task { task_id } => !task_id.is_empty(),
                    }
            }
            McpInteractionSource::RpcError {
                outgoing_request_id,
                method,
                elicitation_id,
                task_id,
            } => {
                request_id(outgoing_request_id)
                    && !method.is_empty()
                    && !elicitation_id.is_empty()
                    && task_id.as_ref().is_none_or(|id| !id.is_empty())
            }
        }
}
impl SourceMcpDeliveryParams {
    fn validate(&self) -> Result<(), KernelError> {
        use SourceMcpDeliveryAction as Action;
        if self.delivery_id.is_empty()
            || !binding_valid(&self.binding)
            || self.kind.is_some() != (self.action == Action::Open)
            || self.cleanup_holder.is_some() && self.action != Action::Open
            || self.request_hash.is_some() != (self.action == Action::Open)
            || self.response_hash.is_some() != (self.action == Action::Begin)
            || self.delivery.is_some() != (self.action == Action::Settle)
            || self.availability.is_some() != (self.action == Action::Close)
            || self.revision.is_some() != matches!(self.action, Action::Ack | Action::Release)
            || self.request_hash.as_ref().is_some_and(|hash| !sha256(hash))
            || self
                .response_hash
                .as_ref()
                .is_some_and(|hash| !sha256(hash))
            || self.delivery == Some(SourceMcpDeliveryState::Sending)
            || self.availability == Some(Availability::Live)
            || self.kind.is_some_and(|kind| {
                (kind == SourceMcpDeliveryKind::Error)
                    != matches!(self.binding.source, McpInteractionSource::RpcError { .. })
            })
        {
            return Err(denied(
                "Original MCP delivery identity or action is incomplete",
            ));
        }
        Ok(())
    }
}
impl Storage {
    pub(crate) fn source_mcp_delivery(
        &mut self,
        p: SourceMcpDeliveryParams,
        epoch: &str,
    ) -> Result<Value, KernelError> {
        use SourceMcpDeliveryAction as Action;
        use SourceMcpDeliveryState as Delivery;
        p.validate()?;
        let address = SourceAuthorityAddress {
            principal_id: p.principal_id,
            coordinator_host_id: p.coordinator_host_id,
            authority_id: p.authority_id,
            resource_epoch: p.resource_epoch,
        };
        // Exact original identity permits factual recall after revoke/restart,
        // but neither observation nor settlement can grant another send.
        let mut record = self.source_authority(&address, false, epoch)?;
        if record.purpose != "mcp_owner" {
            return Err(denied("Original Source is not an MCP owner"));
        }
        let grant = self.load_grant(&record.result.grant_id)?;
        let previous = record
            .result
            .mcp_deliveries
            .iter()
            .position(|receipt| receipt.delivery_id == p.delivery_id);
        if previous.is_some_and(|index| record.result.mcp_deliveries[index].binding != p.binding) {
            return Err(denied("Original MCP delivery binding changed"));
        }
        let created = previous.is_none();
        let mut changed = false;
        let mut dispatch = false;
        let index = match previous {
            Some(index) => index,
            None => {
                if p.action != Action::Open {
                    return Err(denied("Original MCP delivery is unavailable"));
                }
                let cleanup = if let Some(holder) = &p.cleanup_holder {
                    if !holder.validate()
                        || holder.purpose != "resource_observer"
                        || holder.endpoint != p.binding.endpoint
                        || holder.operation_id == p.binding.operation_id
                        || !match &p.binding.source {
                            McpInteractionSource::ServerRequest {
                                relation: McpInteractionRelation::RpcResponseStream { .. },
                                ..
                            } => true,
                            McpInteractionSource::RpcError { method, .. } => {
                                method == "resources/unsubscribe"
                            }
                            _ => false,
                        }
                        || !record.result.mcp_holders.iter().any(|original| {
                            original.binding == *holder && original.creation_receipt.is_some()
                        })
                    {
                        return Err(denied(
                            "MCP cleanup delivery requires its exact original observer holder",
                        ));
                    }
                    true
                } else {
                    false
                };
                self.admit_source_mcp_delivery(&record, epoch, &grant, cleanup)?;
                if cleanup {
                    // Explicit unsubscribe owns a new control Operation. Its
                    // original observer tombstone is the closed admission proof;
                    // no arbitrary new interaction can reopen Source retention.
                    if record.result.phase == "draining" {
                        record.result.phase = "retaining".into();
                    }
                } else if record.result.phase == "retaining" {
                    // An admitted Task may receive a fresh callback after the
                    // finite parent RPC ends. It cannot create a new Task owner.
                    if !record.result.mcp_holders.iter().any(|holder| {
                        !holder.released
                            && holder.binding.purpose == "task"
                            && holder.creation_receipt.is_some()
                            && holder.binding.operation_id == p.binding.operation_id
                            && holder.binding.execution_owner == p.binding.execution_owner
                            && holder.binding.endpoint == p.binding.endpoint
                    }) {
                        return Err(denied(
                            "Sealed Source requires its original retained MCP Task",
                        ));
                    }
                } else {
                    self.source_authority(&address, true, epoch)?;
                }
                record.result.mcp_deliveries.push(SourceMcpDeliveryReceipt {
                    delivery_id: p.delivery_id.clone(),
                    binding: p.binding.clone(),
                    kind: p.kind.expect("validated open kind"),
                    cleanup_holder: p.cleanup_holder.clone(),
                    request_hash: p.request_hash.clone().expect("validated open hash"),
                    revision: 1,
                    response_hash: None,
                    delivery: None,
                    availability: Availability::Live,
                    completed: false,
                    acknowledged_revision: 0,
                    released: false,
                });
                changed = true;
                record.result.mcp_deliveries.len() - 1
            }
        };
        if p.action == Action::Begin && record.result.mcp_deliveries[index].response_hash.is_none()
        {
            self.admit_source_mcp_delivery(&record, epoch, &grant, false)?;
        }
        let receipt = &mut record.result.mcp_deliveries[index];
        let mut fact_changed = false;
        match p.action {
            Action::Open => {
                if Some(receipt.kind) != p.kind
                    || receipt.cleanup_holder != p.cleanup_holder
                    || Some(&receipt.request_hash) != p.request_hash.as_ref()
                {
                    return Err(denied("Original MCP delivery request changed"));
                }
            }
            Action::Inspect => {}
            Action::Begin => {
                let hash = p.response_hash.expect("validated response hash");
                match &receipt.response_hash {
                    Some(original) if original != &hash => {
                        return Err(denied("Original MCP delivery response changed"))
                    }
                    Some(_) => {}
                    None => {
                        if receipt.released
                            || receipt.completed
                            || receipt.availability != Availability::Live
                            || receipt.kind == SourceMcpDeliveryKind::Error
                        {
                            return Err(denied(
                                "Original MCP delivery no longer admits a response",
                            ));
                        }
                        receipt.response_hash = Some(hash);
                        receipt.delivery = Some(Delivery::Sending);
                        fact_changed = true;
                        dispatch = true;
                    }
                }
            }
            Action::Settle => {
                let delivery = p.delivery.expect("validated delivery settlement");
                match receipt.delivery {
                    None => return Err(denied("Original MCP response was not admitted")),
                    Some(Delivery::Sent | Delivery::NotSent) => {
                        // A delayed unknown observation cannot erase positive SDK
                        // evidence; contradictory positive observations conflict.
                        if receipt.delivery != Some(delivery) && delivery != Delivery::Unknown {
                            return Err(denied("Original MCP delivery settlement changed"));
                        }
                    }
                    Some(_) if receipt.delivery != Some(delivery) => {
                        receipt.delivery = Some(delivery);
                        fact_changed = true;
                    }
                    Some(_) => {}
                }
            }
            Action::Close => {
                let availability = p.availability.expect("validated closed availability");
                if receipt.availability != availability {
                    receipt.availability = availability;
                    fact_changed = true;
                }
            }
            Action::Complete => {
                if !receipt.completed {
                    receipt.completed = true;
                    fact_changed = true;
                }
            }
            Action::Ack | Action::Release => {
                let revision = p.revision.expect("validated acknowledged revision");
                if revision > receipt.revision {
                    return Err(denied(
                        "MCP delivery acknowledgement exceeds original facts",
                    ));
                }
                if p.action == Action::Ack {
                    if revision > receipt.acknowledged_revision {
                        receipt.acknowledged_revision = revision;
                        changed = true;
                    }
                } else {
                    // Do not release on an ACK of an earlier projection: close,
                    // completion or SDK settlement may have raced that response.
                    if revision != receipt.revision
                        || receipt.acknowledged_revision < receipt.revision
                    {
                        return Err(denied(
                            "MCP delivery release requires acknowledgement of current facts",
                        ));
                    }
                    if !receipt.released {
                        receipt.released = true;
                        changed = true;
                    }
                }
            }
        }
        if fact_changed {
            receipt.revision = receipt
                .revision
                .checked_add(1)
                .ok_or_else(|| denied("MCP delivery revision exhausted"))?;
            changed = true;
        }
        if record.result.phase == "retaining"
            && record
                .result
                .mcp_holders
                .iter()
                .all(|holder| holder.released)
            && record
                .result
                .mcp_deliveries
                .iter()
                .all(|delivery| delivery.released)
        {
            record.result.phase = "draining".into();
            changed = true;
        }
        if changed {
            self.save_source_record(
                "source.authority",
                &address.authority_id,
                &record.result.source.workspace_id,
                &record.result.phase,
                &record,
            )?;
        }
        Ok(
            json!({"receipt":record.result.mcp_deliveries[index],"dispatch":dispatch,"created":created,"grantState":grant.state,"phase":record.result.phase}),
        )
    }
    fn admit_source_mcp_delivery(
        &self,
        record: &AuthorityRecord,
        epoch: &str,
        grant: &crate::model::Grant,
        cleanup: bool,
    ) -> Result<(), KernelError> {
        let scope: ScopeRecord = self
            .source_record("source.scope", &record.scope_id)?
            .ok_or_else(|| denied("Original MCP source scope is unavailable"))?;
        if !(matches!(record.result.phase.as_str(), "ready" | "retaining")
            || cleanup && record.result.phase == "draining")
            || record.result.resource_epoch != epoch
            || grant.kernel_epoch != epoch
            || grant.state != crate::model::GrantState::Active
            || scope.epoch != record.result.scope.epoch()
            || scope.source != record.result.source
            || scope.closed
        {
            return Err(denied("Original MCP owner no longer admits delivery"));
        }
        Ok(())
    }
}
