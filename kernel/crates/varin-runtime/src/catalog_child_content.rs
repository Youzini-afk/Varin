//! Child state is metadata; task/configuration and executable descriptions are immutable bodies.
use super::*;
use crate::execution::ToolExecutionContext;
use collaboration::{ChildSourcePin, ChildTask, DispatchInput};

pub struct ChildAdmissionPreparation {
    context: ToolExecutionContext,
    input: DispatchInput,
    pin: ChildSourcePin,
    launch: launch_content::PreparedChildLaunch,
    configuration: Value,
    database: std::path::PathBuf,
    content: crate::content::ContentStore,
    publication: crate::content::ContentPublication,
}
pub struct PreparedChildAdmission {
    pub(super) context: ToolExecutionContext,
    pub(super) input_ref: Value,
    pub(super) configuration_ref: Value,
    pub(super) launch: launch_content::LaunchSelectionMetadata,
    pub(super) pin: ChildSourcePin,
    pub(super) parent_tools_ref: Value,
    pub(super) operation_revision: u64,
    pub(super) call_id: String,
    _publication: crate::content::ContentPublication,
}
impl ChildAdmissionPreparation {
    pub fn load(self) -> Result<PreparedChildAdmission> {
        self.input.validate()?;
        let database = Connection::open_with_flags(
            &self.database,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        let operation: Operation = record(&database, "operations", &self.context.operation_id)?;
        let admitted=super::tool_content::ToolIntent::from_operation(&operation)?.load(&self.content)?;
        if admitted.call.name != collaboration::DISPATCH_TOOL
            || admitted.call.arguments != serde_json::to_value(&self.input)?
        {
            return Err(RuntimeError::Conflict(
                "dispatch differs from its admitted call".into(),
            ));
        }
        self.pin.source.validate()?;
        if self.pin.source.mode != SourceMode::FixedBranch
            || self.pin.pin_id.is_empty()
            || self.pin.root.is_empty()
        {
            return Err(RuntimeError::Invalid(
                "child requires a retained fixed source".into(),
            ));
        }
        let mut launch = self.launch.selection;
        launch.source = Some(self.pin.source.clone());
        launch.mcp_binding = None;
        launch.policy_models.clear();
        if launch.policy
            != (crate::execution::PolicyIdentity {
                name: "default".into(),
                version: "1".into(),
            })
            || launch.tools.iter().any(|tool| {
                !matches!(
                    tool.name.as_str(),
                    "file_read" | "file_list" | "file_search"
                )
            })
        {
            return Err(RuntimeError::Conflict(
                "child exceeds its read-only profile".into(),
            ));
        }
        let input_ref = self.content.save(&serde_json::to_value(&self.input)?)?;
        Ok(PreparedChildAdmission {
            context: self.context,
            input_ref,
            operation_revision: operation.revision,
            call_id: admitted.call.call_id,
            configuration_ref: self.content.save(&self.configuration)?,
            launch: launch_content::LaunchSelectionMetadata::stage(&self.content, launch)?,
            pin: self.pin,
            parent_tools_ref: self.launch.parent_tools_ref,
            _publication: self.publication,
        })
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ChildTaskView {
    pub operation_id: String,
    pub parent_run_id: String,
    pub parent_thread_id: String,
    pub parent_branch_id: String,
    pub origin: crate::execution::ToolOrigin,
    pub call_id: String,
    pub child_thread_id: String,
    pub child_branch_id: String,
    pub project_id: Option<String>,
    pub input: DispatchInput,
    pub configuration: Value,
    pub launch: launches::LaunchSelection,
    pub source_pin: ChildSourcePin,
    pub state: String,
    pub revision: u64,
    pub cursor: u64,
    pub receipt: Option<Receipt>,
    pub report: Option<collaboration::ChildReport>,
    pub resources_released: bool,
}
pub struct ChildRead {
    child: ChildTask,
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}
impl ChildRead {
    pub fn load(self) -> Result<ChildTaskView> {
        let child = self.child;
        let input = serde_json::from_value(self.content.load(&child.input_ref)?)?;
        let configuration = self.content.load(&child.configuration_ref)?;
        let launch = child.launch.load(&self.content)?;
        Ok(ChildTaskView {
            operation_id: child.operation_id,
            parent_run_id: child.parent_run_id,
            parent_thread_id: child.parent_thread_id,
            parent_branch_id: child.parent_branch_id,
            origin: child.origin,
            call_id: child.call_id,
            child_thread_id: child.child_thread_id,
            child_branch_id: child.child_branch_id,
            project_id: child.project_id,
            input,
            configuration,
            launch,
            source_pin: child.source_pin,
            state: child.state,
            revision: child.revision,
            cursor: child.cursor,
            receipt: child.receipt,
            report: child.report,
            resources_released: child.resources_released,
        })
    }
}
impl Catalog {
    pub fn capture_child_read(&self, child: ChildTask) -> ChildRead {
        ChildRead {
            child,
            content: self.content.clone(),
            _publication: self.content.begin_publication(),
        }
    }
    pub fn prepare_child_admission(
        &self,
        context: &ToolExecutionContext,
        input: DispatchInput,
        pin: ChildSourcePin,
        launch: launch_content::PreparedChildLaunch,
    ) -> Result<ChildAdmissionPreparation> {
        let run = self.run(&context.run_id)?;
        Ok(ChildAdmissionPreparation {
            context: context.clone(),
            input,
            pin,
            launch,
            configuration: run.configuration,
            database: self
                .db
                .path()
                .ok_or_else(|| RuntimeError::Invalid("Catalog has no persistent database".into()))?
                .into(),
            content: self.content.clone(),
            publication: self.content.begin_publication(),
        })
    }
    /// A replay compares the already committed input identity without loading task text.
    pub fn child_input_preparation(&self) -> ChildInputPreparation {
        ChildInputPreparation {
            content: self.content.clone(),
            _publication: self.content.begin_publication(),
        }
    }
}
pub struct ChildInputPreparation {
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}
impl ChildInputPreparation {
    pub fn reference(&self, input: &DispatchInput) -> Result<Value> {
        self.content.save(&serde_json::to_value(input)?)
    }
}

pub struct ChildReportRead {
    operation_id: String,
    item_id: String,
    offset: usize,
    max_bytes: usize,
    item: HistoryItem,
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}
impl ChildReportRead {
    pub(super) fn new(
        catalog: &Catalog,
        operation_id: &str,
        item_id: &str,
        offset: usize,
        max_bytes: usize,
        item: HistoryItem,
    ) -> Self {
        Self {
            operation_id: operation_id.into(),
            item_id: item_id.into(),
            offset,
            max_bytes,
            item,
            content: catalog.content.clone(),
            _publication: catalog.content.begin_publication(),
        }
    }
    pub fn load(self) -> Result<collaboration::ChildTextPage> {
        let item = self.content.hydrate_history(self.item)?;
        let conversation: crate::execution::ConversationItem =
            serde_json::from_value(item.content)?;
        let crate::execution::Content::Text { text } = conversation.content else {
            return Err(RuntimeError::Invalid("report item is not text".into()));
        };
        let offset = self.offset;
        if offset > text.len() || !text.is_char_boundary(offset) || self.max_bytes == 0 {
            return Err(RuntimeError::Invalid("invalid report byte range".into()));
        }
        // Existing response-page budget leaves JSON escaping headroom in the framed transport.
        let mut end = offset
            .saturating_add(self.max_bytes.min(65536))
            .min(text.len());
        while end > offset && !text.is_char_boundary(end) {
            end -= 1;
        }
        if end == offset && offset < text.len() {
            return Err(RuntimeError::Invalid(
                "maxBytes cannot hold the next UTF-8 character".into(),
            ));
        }
        Ok(collaboration::ChildTextPage {
            operation_id: self.operation_id,
            item_id: self.item_id,
            offset,
            next_offset: (end < text.len()).then_some(end),
            total_bytes: text.len(),
            text: text[offset..end].into(),
        })
    }
}
