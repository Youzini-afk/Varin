//! Child state is metadata; task/configuration and executable descriptions are immutable bodies.
use super::*;
use crate::execution::ToolExecutionContext;
use collaboration::{ChildSourceHandoff, ChildSourceRoot, ChildSource, ChildCodeResult, ChildTask, DispatchInput};

pub struct ChildAdmissionPreparation {
    context: ToolExecutionContext,
    input: DispatchInput,
    handoff: ChildSourceHandoff,
    launch: launch_content::PreparedChildLaunch,
    invocation: super::dispatch::ChildInvocationRead,
    database: std::path::PathBuf,
    content: crate::content::ContentStore,
    publication: crate::content::ContentPublication,
}
pub struct PreparedChildAdmission {
    pub(super) context: ToolExecutionContext,
    pub(super) input_ref: Value,
    pub(super) configuration_ref: Value,
    pub(super) launch: launch_content::LaunchSelectionMetadata,
    pub(super) handoff: ChildSourceHandoff,
    pub(super) work_mode: super::dispatch::ChildWorkMode,
    pub(super) selected_profile_ref: Value,
    pub(super) frozen_reference: Value,
    pub(super) parent_tools_ref: Value,
    pub(super) operation_revision: u64,
    pub(super) call_id: String,
    _publication: crate::content::ContentPublication,
}
impl ChildAdmissionPreparation {
    pub fn load(self) -> Result<PreparedChildAdmission> {
        self.input.validate()?;
        let original = self.invocation.load()?;
        let resolved = original.resolve(&self.input)?;
        if resolved.frozen_reference != self.launch.frozen_reference
            || resolved.profile != self.launch.selected_profile
            || serde_json::to_value(&resolved.model.configuration)? != self.launch.configuration {
            return Err(RuntimeError::Conflict("child selection differs from its original invocation".into()));
        }
        let database = Connection::open_with_flags(
            &self.database,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        let operation: Operation = record(&database, "operations", &self.context.operation_id)?;
        let admitted=super::tool_content::ToolIntent::from_operation(&operation)?.load(&self.content)?;
        if admitted.origin != self.context.origin
            || operation.run_id != self.context.run_id
            || admitted.call.name != collaboration::DISPATCH_TOOL
            || admitted.call.arguments != serde_json::to_value(&self.input)?
        {
            return Err(RuntimeError::Conflict(
                "dispatch differs from its admitted call".into(),
            ));
        }
        self.handoff.source.validate()?;
        if self.handoff.operation_id != format!("child-source-handoff:{}",self.context.operation_id) {
            return Err(RuntimeError::Invalid("child source handoff identity changed".into()));
        }
        match &self.handoff.root {
            ChildSourceRoot::Fixed{pin} if self.handoff.source.mode==SourceMode::FixedBranch && pin.source==self.handoff.source && !pin.pin_id.is_empty() && !pin.root.is_empty()=>(),
            ChildSourceRoot::Physical{root} if self.handoff.source.mode!=SourceMode::FixedBranch && !root.root_id.is_empty() && !root.canonical_root.is_empty()=>(),
            _=>return Err(RuntimeError::Invalid("child source handoff is inconsistent".into()))
        }
        let mut launch = self.launch.selection;
        launch.source = Some(self.handoff.source.clone());
        let input_ref = self.content.save(&serde_json::to_value(&self.input)?)?;
        Ok(PreparedChildAdmission {
            context: self.context,
            input_ref,
            operation_revision: operation.revision,
            call_id: admitted.call.call_id,
            configuration_ref: self.content.save(&self.launch.configuration)?,
            launch: launch_content::LaunchSelectionMetadata::stage(&self.content, launch)?,
            handoff: self.handoff,
            work_mode: self.launch.selected_profile.work_mode,
            selected_profile_ref: self.content.save(&serde_json::to_value(&self.launch.selected_profile)?)?,
            frozen_reference: self.launch.frozen_reference,
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
    pub selected_profile: super::dispatch::ChildSelectedProfile,
    pub launch: launches::LaunchSelection,
    pub source: Value,
    pub code_result: ChildCodeResult,
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
            selected_profile: serde_json::from_value(self.content.load(&child.selected_profile_ref)?)?,
            launch,
            source: {
                let mut source=serde_json::to_value(&child.source)?;
                if let ChildSource::Ready{provenance_ref,..}=&child.source {
                    source.as_object_mut().expect("source object").remove("provenance_ref");
                    source["provenance"]=self.content.load(provenance_ref)?;
                }
                source
            },
            code_result: child.code_result,
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
        handoff: ChildSourceHandoff,
        launch: launch_content::PreparedChildLaunch,
    ) -> Result<ChildAdmissionPreparation> {
        let invocation = self.capture_child_dispatch_invocation(context)?;
        Ok(ChildAdmissionPreparation {
            context: context.clone(),
            input,
            handoff,
            launch,
            invocation,
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

/// The wait target is checked against the admitted argument body outside Catalog's lock.
pub struct ChildWaitRegistrationPreparation {
    context: ToolExecutionContext,
    child_operation_id: String,
    operation: Operation,
    content: crate::content::ContentStore,
    publication: crate::content::ContentPublication,
}
pub struct PreparedChildWaitRegistration {
    pub(super) context: ToolExecutionContext,
    pub(super) child_operation_id: String,
    pub(super) operation_revision: u64,
    pub(super) intent: super::tool_content::ToolIntent,
    _publication: crate::content::ContentPublication,
}
impl ChildWaitRegistrationPreparation {
    pub fn load(self) -> Result<PreparedChildWaitRegistration> {
        let intent = super::tool_content::ToolIntent::from_operation(&self.operation)?;
        let admitted = intent.clone().load(&self.content)?;
        if self.operation.run_id != self.context.run_id
            || admitted.origin != self.context.origin
            || admitted.call.name != collaboration::WAIT_TOOL
            || admitted.call.arguments != json!({"operationId": self.child_operation_id})
        {
            return Err(RuntimeError::Conflict(
                "child wait differs from its admitted call".into(),
            ));
        }
        Ok(PreparedChildWaitRegistration {
            context: self.context,
            child_operation_id: self.child_operation_id,
            operation_revision: self.operation.revision,
            intent,
            _publication: self.publication,
        })
    }
}
impl Catalog {
    pub fn prepare_child_wait_registration(
        &self,
        context: &ToolExecutionContext,
        child_operation_id: &str,
    ) -> Result<ChildWaitRegistrationPreparation> {
        Ok(ChildWaitRegistrationPreparation {
            context: context.clone(),
            child_operation_id: child_operation_id.into(),
            operation: self.operation(&context.operation_id)?,
            content: self.content.clone(),
            publication: self.content.begin_publication(),
        })
    }
}
