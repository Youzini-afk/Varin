//! Line selection over the original byte stream, shared by live and fixed sources.
use super::*;

pub(crate) struct LineRead;
impl LineRead {
    pub(crate) fn from_params(params: &Value) -> Result<Option<Self>, KernelError> {
        if params.get("startLine").is_none() && params.get("endLine").is_none() { return Ok(None); }
        let invalid = || KernelError::Operation("Use positive, inclusive startLine/endLine without a byte offset or length".into());
        let first = params["startLine"].as_u64().filter(|value| *value > 0).ok_or_else(invalid)?;
        let last = params.get("endLine").map(|value| value.as_u64().filter(|value| *value >= first).ok_or_else(invalid)).transpose()?.unwrap_or(u64::MAX);
        if params["offset"].as_u64().unwrap_or(0) != 0 || params.get("length").is_some() { return Err(invalid()); }
        let _ = last;
        Ok(Some(Self))
    }
}
