//! Verifiable frozen Host implementation graph. Selection and live authority remain in the Host.
use super::{Result, RuntimeError};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostCompositionProvider {
    pub node_id: String,
    pub provider_key: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostCompositionDependency {
    pub id: String,
    pub version: u64,
    pub binding: String,
    pub optional: bool,
    pub providers: Vec<HostCompositionProvider>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostCompositionGrant {
    pub capability: String,
    pub granted: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostCompositionNode {
    pub id: String,
    pub extension_id: String,
    pub entrypoint_id: String,
    pub extension_version: String,
    pub artifact_integrity: String,
    pub activation_configuration: serde_json::Value,
    pub grants: Vec<HostCompositionGrant>,
    pub dependencies: Vec<HostCompositionDependency>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostServiceComposition {
    pub schema_version: u64,
    pub root: String,
    pub nodes: Vec<HostCompositionNode>,
}

fn invalid(message: &str) -> RuntimeError {
    RuntimeError::Invalid(format!("Host service composition: {message}"))
}
// Explicit ordering does not depend on serde_json feature unification elsewhere in the workspace.
fn canonical(value: &serde_json::Value, out: &mut Vec<u8>) -> Result<()> {
    match value {
        serde_json::Value::Object(object) => {
            out.push(b'{');
            let sorted: BTreeMap<_, _> = object.iter().collect();
            for (index, (key, value)) in sorted.into_iter().enumerate() {
                if index > 0 {
                    out.push(b',');
                }
                serde_json::to_writer(&mut *out, key)?;
                out.push(b':');
                canonical(value, out)?;
            }
            out.push(b'}');
        }
        serde_json::Value::Array(array) => {
            out.push(b'[');
            for (index, value) in array.iter().enumerate() {
                if index > 0 {
                    out.push(b',');
                }
                canonical(value, out)?;
            }
            out.push(b']');
        }
        _ => serde_json::to_writer(out, value)?,
    }
    Ok(())
}
impl HostCompositionNode {
    pub fn content_identity(&self) -> Result<String> {
        let mut value = serde_json::to_value(self)?;
        value
            .as_object_mut()
            .ok_or_else(|| invalid("invalid node"))?
            .remove("id");
        let mut bytes = Vec::new();
        canonical(&value, &mut bytes)?;
        Ok(hex::encode(Sha256::digest(bytes)))
    }
}
impl HostServiceComposition {
    pub fn validate(&self) -> Result<()> {
        if self.schema_version != 1 || self.root.is_empty() {
            return Err(invalid("unsupported graph"));
        }
        let nodes: BTreeMap<_, _> = self
            .nodes
            .iter()
            .map(|node| (node.id.as_str(), node))
            .collect();
        if nodes.len() != self.nodes.len() || !nodes.contains_key(self.root.as_str()) {
            return Err(invalid("missing or duplicate root/node"));
        }
        for node in &self.nodes {
            if [
                &node.id,
                &node.extension_id,
                &node.extension_version,
                &node.artifact_integrity,
            ]
            .iter()
            .any(|value| value.is_empty())
                || node.entrypoint_id != "host"
                || !node.activation_configuration.is_null()
                || node.content_identity()? != node.id
            {
                return Err(invalid("invalid node identity"));
            }
            let mut grants = BTreeSet::new();
            if node
                .grants
                .iter()
                .any(|grant| grant.capability.is_empty() || !grants.insert(&grant.capability))
            {
                return Err(invalid("invalid grant identity"));
            }
            let mut requirements = BTreeSet::new();
            for dependency in &node.dependencies {
                if dependency.id.is_empty()
                    || dependency.version == 0
                    || !requirements.insert((&dependency.id, dependency.version))
                    || !["single", "selected", "all"].contains(&dependency.binding.as_str())
                    || (!dependency.optional && dependency.providers.is_empty())
                    || (dependency.binding != "all" && dependency.providers.len() > 1)
                {
                    return Err(invalid("invalid dependency"));
                }
                let mut providers = BTreeSet::new();
                for provider in &dependency.providers {
                    let target = nodes
                        .get(provider.node_id.as_str())
                        .ok_or_else(|| invalid("missing dependency node"))?;
                    let expected = format!(
                        "{}:host:{}@{}",
                        target.extension_id, dependency.id, dependency.version
                    );
                    if provider.provider_key != expected
                        || !providers.insert(&provider.provider_key)
                    {
                        return Err(invalid("invalid dependency provider"));
                    }
                }
            }
        }
        let mut visiting = BTreeSet::new();
        let mut visited = BTreeSet::new();
        let mut stack = vec![(self.root.as_str(), false)];
        while let Some((id, exit)) = stack.pop() {
            if exit {
                visiting.remove(id);
                visited.insert(id);
                continue;
            }
            if visited.contains(id) {
                continue;
            }
            if !visiting.insert(id) {
                return Err(invalid("dependency cycle"));
            }
            stack.push((id, true));
            for dependency in &nodes[id].dependencies {
                for provider in &dependency.providers {
                    stack.push((provider.node_id.as_str(), false));
                }
            }
        }
        if visited.len() != nodes.len() {
            return Err(invalid("unreachable node"));
        }
        Ok(())
    }
    pub fn validate_root(
        &self,
        extension_id: &str,
        version: &str,
        integrity: &str,
        provider_key: &str,
        service_id: &str,
        service_version: u64,
    ) -> Result<()> {
        self.validate()?;
        let root = self
            .nodes
            .iter()
            .find(|node| node.id == self.root)
            .ok_or_else(|| invalid("missing root"))?;
        if root.extension_id != extension_id
            || root.extension_version != version
            || root.artifact_integrity != integrity
            || provider_key != format!("{extension_id}:host:{service_id}@{service_version}")
        {
            return Err(invalid("root differs from frozen binding"));
        }
        Ok(())
    }
}
