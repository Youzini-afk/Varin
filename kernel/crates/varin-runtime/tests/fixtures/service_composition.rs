//! Valid immutable composition identities for tests which exercise original binding consumers.
use varin_runtime::catalog::service_composition::{HostCompositionNode, HostServiceComposition};
pub fn graph(extension_id: &str, version: &str, artifact: &str) -> HostServiceComposition {
    let mut node = HostCompositionNode {
        id: String::new(),
        extension_id: extension_id.into(),
        entrypoint_id: "host".into(),
        extension_version: version.into(),
        artifact_integrity: artifact.into(),
        activation_configuration: serde_json::Value::Null,
        grants: vec![],
        dependencies: vec![],
    };
    node.id = node.content_identity().unwrap();
    HostServiceComposition {
        schema_version: 1,
        root: node.id.clone(),
        nodes: vec![node],
    }
}
