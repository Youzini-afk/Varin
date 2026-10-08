use super::{Result,Shared,Task,source,structure::SyntaxRuntime};
use crate::model::PathState;
use base64::{engine::general_purpose::STANDARD,Engine};
use grep_matcher::Matcher;
use grep_regex::RegexMatcherBuilder;
use serde_json::{json,Value};
use sha2::{Digest,Sha256};
use std::collections::{HashMap,HashSet};

const TEXT_BATCH_BYTES:usize=64*1024;
fn text_batches(shared:&Shared,kind:&str,path:&str,revision:&str,text:&str,metadata:&Value)->Result<()> {
    let mut offset=0;
    loop {
        shared.check()?;let mut end=(offset+TEXT_BATCH_BYTES).min(text.len());
        while !text.is_char_boundary(end){end-=1;}
        let mut data=metadata.clone();data["text"]=json!(&text[offset..end]);data["offset"]=json!(offset);
        data["final"]=json!(end==text.len());shared.emit(kind,path,revision,data)?;
        if end==text.len(){break;}offset=end;
    }Ok(())
}
fn source_lines(text:&str)->Vec<&str>{text.split('\n').map(|s|s.strip_suffix('\r').unwrap_or(s)).collect()}
fn search_lines(text:&str)->Vec<&str>{let mut lines=source_lines(text);if text.ends_with('\n'){lines.pop();}lines}
fn line_range(lines:&[&str],start:usize,end:usize)->String{lines.get(start.saturating_sub(1)..end.min(lines.len())).unwrap_or_default().join("\n")}
fn container(kind:&str,json:bool)->bool{if json{matches!(kind,"property"|"object"|"array")}else{
    matches!(kind,"function"|"method"|"constructor"|"class"|"interface"|"enum"|"module"|"namespace"|"type"|"struct"|"package")}}
/// Native structural units are model-neutral. Tokenizer-accurate packing and
/// embedding decoration remain with the TS model adapter, never char estimates.
fn units(shared:&Shared,path:&str,revision:&str,text:&str,analysis:Option<&Value>,max_lines:usize,json_language:bool)->Result<()> {
    let lines=source_lines(text);if text.is_empty(){return Ok(());}
    let symbols=analysis.and_then(|a|a["symbols"].as_array()).cloned().unwrap_or_default();
    let range=|s:&Value|->(usize,usize){(s["range"]["startLine"].as_u64().unwrap_or(1) as usize,s["range"]["endLine"].as_u64().unwrap_or(1) as usize)};
    let mut candidates=symbols.iter().filter(|s|container(s["kind"].as_str().unwrap_or_default(),json_language)).collect::<Vec<_>>();
    candidates.sort_by_key(|s|{let(start,end)=range(s);(start,std::cmp::Reverse(end))});
    // Sorted intervals make ancestor selection linear after sorting. Comparing
    // every symbol with every other symbol stalls generated/large source files.
    let mut top=Vec::new();let mut furthest=0;
    for symbol in &candidates{shared.check()?;let(_,end)=range(symbol);if end>furthest{top.push(*symbol);furthest=end;}}
    let mut ranges=Vec::<(usize,usize,Option<&Value>)>::new();let mut covered=1usize;
    for symbol in top{
        let(start,end)=range(symbol);if end<start||start>lines.len()||start<covered{continue;}
        if start>covered{ranges.push((covered,start-1,None));}
        ranges.push((start,end.min(lines.len()),Some(symbol)));covered=covered.max(end+1);
    }
    if covered<=lines.len(){ranges.push((covered,lines.len(),None));}
    for(start,end,parent)in ranges{
        let name=parent.and_then(|p|p["name"].as_str()).unwrap_or("");
        let kind=parent.and_then(|p|p["kind"].as_str()).unwrap_or("file");
        let signature=parent.map(|p|line_range(&lines,p["signature"]["startLine"].as_u64().unwrap_or(start as u64) as usize,p["signature"]["endLine"].as_u64().unwrap_or(start as u64) as usize)).unwrap_or_default();
        let mut comment_start=start.saturating_sub(1);
        while comment_start>0&&["//","/*","*","#"].iter().any(|prefix|lines[comment_start-1].trim_start().starts_with(prefix)){comment_start-=1;}
        let comments=if comment_start<start.saturating_sub(1){lines[comment_start..start-1].join("\n")}else{String::new()};
        let mut first=start;
        while first<=end{
            shared.check()?;let mut last=first.saturating_add(max_lines.saturating_sub(1)).min(end);
            if last<end{
                // Prefer the last complete child boundary inside this batch.
                let from=candidates.partition_point(|s|range(s).0<first);
                let to=candidates.partition_point(|s|range(s).0<=last);
                if let Some(boundary)=candidates[from..to].iter().map(|s|range(s)).filter(|(_,b)|*b<=last&&*b>first).map(|(_,b)|b).max(){last=boundary;}
            }
            let body=line_range(&lines,first,last);
            text_batches(shared,"unit",path,revision,&body,&json!({"startLine":first,"endLine":last,"parentName":name,"parentKind":kind,
                "parentSignature":signature,"docComments":comments,"fallback":parent.is_none()||first!=start||last!=end,
                "contentHash":hex::encode(Sha256::digest(body.as_bytes()))}))?;
            first=last+1;
        }
    }Ok(())
}
pub(crate) fn execute(mut task:Task,shared:&Shared,syntax:&mut SyntaxRuntime)->Result<bool>{
    shared.check()?;
    if task.params.operation == "inventory" { return source::inventory(&task, shared); }
    let params=task.params.clone();
    let files=params.files.clone().unwrap_or_default().into_iter().map(|f|(f.path.clone(),f)).collect::<HashMap<_,_>>();
    let recipes=task.recipes.clone();
    if params.operation=="grammar" {
        for file in files.values() {
            let recipe=file.recipe_id.as_ref().and_then(|id|recipes.get(id)).ok_or("Native grammar recipe is unavailable")?;
            let probe=syntax.probe(recipe, shared)?;
            shared.emit("grammar", &file.path, &recipe.recipe_id, probe)?;
        }
        return Ok(false);
    }
    let query=params.query.as_deref().unwrap_or_default();
    let matcher=if params.operation=="search"{
        let mut builder=RegexMatcherBuilder::new();builder.case_insensitive(params.ignore_case.unwrap_or(false));
        Some(if params.fixed_strings.unwrap_or(false){builder.build_literals(&[query])}else{builder.build(query)}.map_err(|e|format!("Invalid search expression: {e}"))?)
    }else{None};
    let name_matcher=if params.operation=="list"&&!query.is_empty(){Some(query.to_lowercase())}else{None};
    let mut count=0u64;let mut found=HashSet::new();let mut structure_failed=false;let mut limited=false;
    let partial=source::visit(&mut task,shared,|document|{
        shared.check()?;let path=&document.path;let revision=&document.revision;
        if !files.is_empty()&&!files.contains_key(path){return Ok(true);}
        if params.operation=="list"{
            if name_matcher.as_ref().is_some_and(|q|!path.to_lowercase().contains(q)){return Ok(true);}
            let kind=match &document.state{PathState::Directory{..}=>"directory",PathState::Symlink{..}=>"symlink",PathState::RegularFile{..}=>"file",_=>"unsupported"};
            let mut data=json!({"kind":kind,"state":document.state});
            if let Some(metadata)=document.metadata {
                data["metadata"]=json!({"byteLength":metadata.byte_length.to_string(),"modifiedTimeNs":metadata.modified_time_ns});
            }
            shared.emit("entry",path,revision,data)?;count+=1;
        }else if let Some(bytes)=document.bytes{
            shared.scanned();found.insert(path.clone());
            if matches!(params.operation.as_str(),"structure"|"chunks"){
                if files.get(path).and_then(|f|f.revision.as_deref()).is_some_and(|requested|requested!=revision){
                    shared.emit("structure",path,revision,json!({"status":"stale","message":"The structure source revision changed"}))?;
                    structure_failed=true;return Ok(true);
                }
                let metadata=document.metadata.map(|m|json!({"byteLength":m.byte_length.to_string(),"modifiedTimeNs":m.modified_time_ns}));
                let unchanged=files.get(path).and_then(|f|f.unchanged_revision.as_deref())==Some(revision.as_str());
                shared.emit("document",path,revision,json!({"status":if unchanged{"unchanged"}else{"captured"},"metadata":metadata}))?;
                if unchanged{return Ok(true);}
            }
            if params.operation=="bytes"{
                let start=params.byte_offset.unwrap_or(0) as usize;let length=params.byte_length.unwrap_or(TEXT_BATCH_BYTES as i64) as usize;
                let end=start.saturating_add(length).min(bytes.len());
                if start>bytes.len(){return Err("Byte offset is beyond the fixed file".into());}
                for(offset,chunk)in bytes[start..end].chunks(TEXT_BATCH_BYTES).enumerate(){shared.emit("bytes",path,revision,json!({"bytesBase64":STANDARD.encode(chunk),"offset":start+offset*TEXT_BATCH_BYTES,"byteLength":bytes.len()}))?;}
                if start==end{shared.emit("bytes",path,revision,json!({"bytesBase64":"","offset":start,"byteLength":bytes.len()}))?;}
            }else{
                let text=match std::str::from_utf8(&bytes){Ok(text)if !text.contains('\0')=>text,_=>{
                    if params.operation!="search"{shared.emit("document",path,revision,json!({"status":"binary","byteLength":bytes.len()}))?;}return Ok(true);
                }};
                if let Some(matcher)=&matcher{
                    let lines=search_lines(text);
                    for(index,line)in lines.iter().enumerate(){shared.check()?;
                        if let Some(matched)=matcher.find(line.as_bytes()).map_err(|e|e.to_string())?{
                            if !line.is_char_boundary(matched.start()) {return Err("Search expression matched inside a UTF-8 codepoint".into());}
                            let before=params.before.unwrap_or(0) as usize;let after=params.after.unwrap_or(0) as usize;
                            shared.emit("hit",path,revision,json!({"line":index+1,"column":line[..matched.start()].encode_utf16().count()+1,"preview":line,
                                "before":lines[index.saturating_sub(before)..index],"after":lines[(index+1)..(index+1+after).min(lines.len())]}))?;
                            count+=1;if params.max_results.is_some_and(|max|count>=max as u64){limited=true;return Ok(false);}
                        }
                    }
                }else if params.operation=="read"{
                    let lines=source_lines(text);let start=params.start_line.unwrap_or(1) as usize;
                    let end=params.end_line.unwrap_or(lines.len() as i64) as usize;
                    let body=if params.start_line.is_none()&&params.end_line.is_none(){text.to_string()}else{line_range(&lines,start,end)};
                    text_batches(shared,"text",path,revision,&body,&json!({"startLine":start,"endLine":end.min(lines.len()),"totalLines":lines.len(),"byteLength":bytes.len()}))?;
                }else if matches!(params.operation.as_str(),"structure"|"chunks"){
                    let file=files.get(path);
                    let recipe=file.and_then(|f|f.recipe_id.as_ref()).and_then(|id|recipes.get(id));
                    let analysis=match recipe{
                        Some(recipe)=>match syntax.analyze(recipe,text,file.and_then(|f|f.lines.as_deref()).unwrap_or_default(),params.parse_budget_ms.unwrap_or(250) as u64,
                            document.state.object_hash().and_then(|hash|hash.strip_prefix("sha256-")).ok_or("Captured content identity is unavailable")?,shared){
                            Ok(value)=>Some(value),Err(error)=>{shared.check()?;
                                let status=if error.starts_with("unavailable:"){"unavailable"}else{"failed"};
                                shared.emit("structure",path,revision,json!({"status":status,"message":error,"recipeId":recipe.recipe_id}))?;structure_failed=true;None
                            }
                        },None=>{shared.emit("structure",path,revision,json!({"status":"unsupported","message":"No native grammar recipe supplied"}))?;None}
                    };
                    if let Some(mut value)=analysis.clone(){
                        for category in ["symbols","hits","calls","imports"]{
                            let records=value[category].as_array().cloned().unwrap_or_default();
                            value.as_object_mut().unwrap().remove(category);
                            for batch in records.chunks(256){shared.emit("structure-part",path,revision,json!({"category":category,"items":batch}))?;}
                        }
                        // Line lengths are bounded batches too, not a giant side channel.
                        let lengths=value["lineLengths"].take();
                        if let Some(lengths)=lengths.as_array(){for(offset,batch)in lengths.chunks(2048).enumerate(){shared.emit("structure-part",path,revision,json!({"category":"lineLengths","offset":offset*2048,"items":batch}))?;}}
                        shared.emit("structure",path,revision,value)?;
                    }
                    if params.operation=="chunks"{units(shared,path,revision,text,analysis.as_ref(),params.chunk_lines.unwrap_or(i64::MAX) as usize,recipe.is_some_and(|r|r.style=="json"))?;}
                    if params.include_text.unwrap_or(false){text_batches(shared,"text",path,revision,text,&json!({"byteLength":bytes.len()}))?;}
                }else{return Err("Unknown native computation operation".into());}
            }
        }
        if params.operation=="list"&&params.max_results.is_some_and(|max|count>=max as u64){limited=true;return Ok(false);}
        Ok(true)
    })?;
    if matches!(params.operation.as_str(),"read"|"bytes"|"structure"|"chunks"){
        for file in files.keys(){if !found.contains(file){shared.emit("document",file,"",json!({"status":"missing"}))?;}}
    }
    Ok(partial||structure_failed||limited)
}
