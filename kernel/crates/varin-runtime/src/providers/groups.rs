//! Reuse complete protocol groups by the immutable items that actually determine them.
//! A changed final group is rebuilt; unchanged groups retain their encoded payloads.
use super::*;
use crate::request_body::FrozenJson;
use std::collections::BTreeMap;

type GroupKey = (&'static str, String, Vec<(usize, bool)>);
type GroupEntry = (ConversationHistory, Arc<FrozenJson>);

#[derive(Default)]
pub(crate) struct CompiledGroups {
    entries: BTreeMap<GroupKey, GroupEntry>,
    fields: BTreeMap<&'static str, Arc<FrozenJson>>,
}

pub(super) struct GroupCompiler {
    retain: bool,
    previous: CompiledGroups,
    current: CompiledGroups,
}
impl GroupCompiler {
    pub(super) fn new(reuse: Option<&mut RequestCompileReuse>) -> Self {
        Self {
            retain: reuse.is_some(),
            previous: reuse
                .map(|reuse| std::mem::take(&mut reuse.groups))
                .unwrap_or_default(),
            current: CompiledGroups::default(),
        }
    }
    pub(super) fn group(
        &mut self,
        kind: &'static str,
        sources: &[ProjectedHistoryItem<'_>],
        compile: impl FnOnce() -> Result<Value, ExecutionError>,
    ) -> Result<Arc<FrozenJson>, ExecutionError> {
        self.group_context(kind, String::new(), sources, compile)
    }
    pub(super) fn group_context(
        &mut self,
        kind: &'static str,
        context: String,
        sources: &[ProjectedHistoryItem<'_>],
        compile: impl FnOnce() -> Result<Value, ExecutionError>,
    ) -> Result<Arc<FrozenJson>, ExecutionError> {
        if !self.retain {
            return Ok(FrozenJson::new(compile()?));
        }
        let key = (
            kind,
            context,
            sources
                .iter()
                .map(|source| (Arc::as_ptr(source.item) as usize, source.opaque.is_some()))
                .collect(),
        );
        // Entries retain their source Arcs, so addresses cannot be recycled while a key is live.
        let entry = match self.previous.entries.remove(&key) {
            Some(entry) => entry,
            None => (
                sources.iter().map(|source| source.item.clone()).collect(),
                FrozenJson::new(compile()?),
            ),
        };
        let fragment = entry.1.clone();
        self.current.entries.insert(key, entry);
        Ok(fragment)
    }
    /// Only configuration-derived fields belong here. Request-local instructions use group().
    pub(super) fn field(
        &mut self,
        key: &'static str,
        compile: impl FnOnce() -> Value,
    ) -> Arc<FrozenJson> {
        if !self.retain {
            return FrozenJson::new(compile());
        }
        let value = self
            .previous
            .fields
            .remove(key)
            .unwrap_or_else(|| FrozenJson::new(compile()));
        self.current.fields.insert(key, value.clone());
        value
    }
    pub(super) fn finish(self, reuse: Option<&mut RequestCompileReuse>) {
        if let Some(reuse) = reuse {
            reuse.groups = self.current;
        }
    }
}

pub(super) type HistoryGroup<'a> = (&'static str, Vec<ProjectedHistoryItem<'a>>);

/// System items have their own array and do not break a protocol's adjacent-role grouping.
pub(super) fn group_history<'a>(
    history: impl IntoIterator<Item = ProjectedHistoryItem<'a>>,
    mut role: impl FnMut(&ProjectedHistoryItem<'a>) -> Result<Option<&'static str>, ExecutionError>,
) -> Result<(Vec<ProjectedHistoryItem<'a>>, Vec<HistoryGroup<'a>>), ExecutionError> {
    let mut system = Vec::new();
    let mut groups: Vec<HistoryGroup<'a>> = Vec::new();
    for item in history {
        let Some(role) = role(&item)? else {
            continue;
        };
        if role == "system" {
            system.push(item);
        } else if let Some((_, items)) = groups.last_mut().filter(|(last, _)| *last == role) {
            items.push(item);
        } else {
            groups.push((role, vec![item]));
        }
    }
    Ok((system, groups))
}
