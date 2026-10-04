//! The existing grammar/query recipes execute in native tree-sitter. There is
//! no Host text/tree cache and no replacement language or search algorithm.
use super::{Result,Shared};
use crate::protocol_generated::KernelComputeGrammarParams;
use serde_json::{json,Value};
use sha2::{Digest,Sha256};
use std::{collections::{HashMap,HashSet},fs,ops::ControlFlow,sync::Arc,time::{Duration,Instant}};
use streaming_iterator::StreamingIterator;
use tree_sitter::{Language,Node,Parser,Query,QueryCursor,QueryCursorOptions,ParseOptions,WasmStore,wasmtime};

struct CompiledQueries {
    definition: Option<Query>,
    literal_call: Option<Query>,
    imports: Option<Query>,
}
struct CachedQueries {
    recipe_id: String,
    compiled: Arc<CompiledQueries>,
}
struct CachedLanguage {
    language: Language,
    // Keep only the latest immutable recipe for this grammar name + hash.
    // Replacing a recipe evicts executable queries, never source text or trees.
    queries: Option<CachedQueries>,
}
#[derive(Default)]
pub(crate) struct SyntaxRuntime {
    parser: Option<Parser>,
    languages: HashMap<String, CachedLanguage>,
    #[cfg(test)]
    compiled_query_count: usize,
}
impl SyntaxRuntime {
    fn language(&mut self,recipe:&KernelComputeGrammarParams,shared:&Shared)->Result<(String,Language)>{
        shared.check()?;
        let bytes=fs::read(&recipe.grammar_path).map_err(|_|"unavailable: grammar WASM is not readable".to_string())?;
        let grammar_hash=format!("sha256-{}",hex::encode(Sha256::digest(&bytes)));
        if recipe.grammar_hash.as_deref()!=Some(grammar_hash.as_str()){return Err("unavailable: Grammar bytes changed after recipe admission".into());}
        let key=format!("{}:{}",recipe.grammar_name,grammar_hash);
        if let Some(cached)=self.languages.get(&key){return Ok((key,cached.language.clone()));}
        // Cache capacity is eviction, not a language admission limit. Resetting
        // the store also drops compiled modules; no tree escapes this worker.
        if self.languages.len()>=32 {self.languages.clear();self.parser=None;}
        if self.parser.is_none(){
            let store=WasmStore::new(&wasmtime::Engine::default()).map_err(|e|format!("unavailable: {e}"))?;
            let mut parser=Parser::new();parser.set_wasm_store(store).map_err(|e|format!("unavailable: {e}"))?;
            self.parser=Some(parser);
        }
        let parser=self.parser.as_mut().unwrap();
        let mut store=parser.take_wasm_store().ok_or("unavailable: native grammar store is unavailable")?;
        let result=store.load_language(&recipe.grammar_name,&bytes).map_err(|e|format!("unavailable: {e}"));
        parser.set_wasm_store(store).map_err(|e|format!("unavailable: {e}"))?;
        shared.check()?;
        let language=result?;
        if !(tree_sitter::MIN_COMPATIBLE_LANGUAGE_VERSION..=tree_sitter::LANGUAGE_VERSION).contains(&language.abi_version()){
            return Err(format!("unavailable: Grammar ABI {} is incompatible with this native runtime",language.abi_version()));
        }
        self.languages.insert(key.clone(),CachedLanguage{language:language.clone(),queries:None});Ok((key,language))
    }
    fn queries(&mut self, language_key: &str, recipe: &KernelComputeGrammarParams, shared: &Shared) -> Result<Arc<CompiledQueries>> {
        shared.check()?;
        let cached = self.languages.get_mut(language_key).ok_or("unavailable: Native grammar cache entry is unavailable")?;
        if let Some(queries) = &cached.queries {
            if queries.recipe_id == recipe.recipe_id { return Ok(queries.compiled.clone()); }
        }
        let language = &cached.language;
        let compile = |source: &str| -> Result<Query> {
            shared.check()?;
            let query = Query::new(language, source).map_err(|error| format!("unavailable: Grammar query is incompatible: {error}"))?;
            shared.check()?;
            Ok(query)
        };
        let queries = Arc::new(CompiledQueries {
            definition: if recipe.style == "json" { None } else { Some(compile(&recipe.definition_query)?) },
            literal_call: recipe.literal_call_query.as_deref().map(compile).transpose()?,
            imports: recipe.import_query.as_deref().map(compile).transpose()?,
        });
        #[cfg(test)] {
            self.compiled_query_count += usize::from(queries.definition.is_some())
                + usize::from(queries.literal_call.is_some()) + usize::from(queries.imports.is_some());
        }
        // Publish only a complete successful recipe. Existing Arc users keep
        // their compiled queries alive while this entry replaces its owner.
        cached.queries = Some(CachedQueries { recipe_id: recipe.recipe_id.clone(), compiled: queries.clone() });
        Ok(queries)
    }
    pub fn probe(&mut self, recipe: &KernelComputeGrammarParams, shared: &Shared) -> Result<Value> {
        let (_, language) = self.language(recipe, shared)?;
        Ok(json!({"abi": language.abi_version(), "recipeId": recipe.recipe_id}))
    }
    pub fn analyze(&mut self,recipe:&KernelComputeGrammarParams,text:&str,lines:&[i64],budget_ms:u64,content_hash:&str,shared:&Shared)->Result<Value>{
        let (language_key,language)=self.language(recipe,shared)?;
        let parser=self.parser.as_mut().unwrap();
        parser.set_language(&language).map_err(|e|format!("unavailable: {e}"))?;
        let started=Instant::now();let budget=Duration::from_millis(budget_ms);
        let expired=||shared.check().is_err()||started.elapsed()>budget;
        let bytes=text.as_bytes();
        let mut progress=|_:&tree_sitter::ParseState|if expired(){ControlFlow::Break(())}else{ControlFlow::Continue(())};
        let tree=parser.parse_with_options(&mut|offset,_|bytes.get(offset..).unwrap_or_default(),None,
            Some(ParseOptions::new().progress_callback(&mut progress)));
        shared.check()?;
        let tree=tree.ok_or("failed: Parse budget exhausted before the file was finished")?;
        if expired(){return Err("failed: Parse budget exhausted before the file was finished".into());}
        let root=tree.root_node();
        let compiled=self.queries(&language_key,recipe,shared)?;
        if expired(){return Err("failed: Structure query budget exhausted".into());}
        let mut symbols=Vec::new();let mut names=HashSet::new();let mut seen=HashSet::new();
        if recipe.style=="json"{
            let mut collector=JsonOutline{symbols:&mut symbols,names:&mut names,seen:&mut seen,max_depth:recipe.max_depth.unwrap_or(8) as usize,
                max_symbols:recipe.max_symbols.unwrap_or(256) as usize,text:bytes,shared};
            collector.collect(root)?;
        }else{
            matches(compiled.definition.as_ref().ok_or("unavailable: Definition query is unavailable")?,root,bytes,&expired,|captures|{
                let name=captures.iter().find(|(name,_)|*name=="name").map(|(_,node)|*node);
                if let Some(name)=name{names.insert(name.start_position().row+1);}
                let definition=if recipe.style=="tags"{captures.iter().find(|(name,_)|name.starts_with("definition."))}
                    else{captures.iter().find(|(name,_)|*name=="unit")};
                let Some((capture,unit))=definition else{return Ok(());};
                if recipe.style!="tags"&&!is_outline(*unit){return Ok(());}
                let named=name.or_else(||unit.child_by_field_name("name"));
                if recipe.style=="tags"&&named.is_none(){return Ok(());}
                let name=named.map(|n|node_text(n,bytes)).filter(|s|!s.is_empty()).unwrap_or("default");
                let kind=if recipe.style=="tags"{tags_kind(capture)}else{kind_for(*unit)};
                push_symbol(&mut symbols,&mut seen,name,kind,*unit,named);Ok(())
            })?;
        }
        shared.check()?;
        let mut hits=Vec::new();
        for line in lines {shared.check()?;if *line<1{return Err("failed: hit line must be positive".into());}
            let row=*line as usize-1;
            let class=if line_has(root,row,|kind|if recipe.style=="tags"{kind.contains("comment")}else{matches!(kind,"comment"|"html_comment")},shared)?{"comment"}
                else if names.contains(&(*line as usize)){"name"}
                else if line_has(root,row,|kind|if recipe.style=="tags"{kind.contains("string")||kind.contains("char_literal")}
                    else{matches!(kind,"string"|"template_string"|"string_fragment"|"string_content"|"escape_sequence")},shared)?{"string"}else{"body"};
            hits.push(json!({"line":line,"class":class}));
        }
        let mut calls=Vec::new();let mut imports=Vec::new();
        if let Some(query)=&compiled.literal_call{
            matches(query,root,bytes,&expired,|captures|{
                let function=captures.iter().find(|(name,_)|*name=="fn").map(|(_,n)|*n);
                let literal=captures.iter().find(|(name,_)|*name=="literal").map(|(_,n)|*n);
                if let (Some(function),Some(literal))=(function,literal){calls.push(json!({"name":node_text(function,bytes),"literal":unquote(node_text(literal,bytes)),"line":literal.start_position().row+1}));}
                Ok(())
            })?;
        }
        if let Some(query)=&compiled.imports{
            matches(query,root,bytes,&expired,|captures|{
                if let Some((_,source))=captures.iter().find(|(name,_)|*name=="source"){
                    imports.push(json!({"source":unquote(node_text(*source,bytes)),"line":source.start_position().row+1}));
                }Ok(())
            })?;
        }
        shared.check()?;
        if expired(){return Err("failed: Structure query budget exhausted".into());}
        Ok(json!({"status":if symbols.is_empty(){"empty"}else{"ready"},"symbols":symbols,"hits":hits,"calls":calls,"imports":imports,
            "callsStatus":if recipe.literal_call_query.is_some(){"ready"}else{"unsupported"},
            "importsStatus":if recipe.import_query.is_some(){"ready"}else{"unsupported"},
            "recipeId":recipe.recipe_id,"abi":language.abi_version(),"contentHash":content_hash,
            "lineLengths":text.split('\n').map(|l|l.trim_end_matches('\r').encode_utf16().count()).collect::<Vec<_>>() }))
    }
}
fn matches<'tree>(query:&Query,root:Node<'tree>,text:&[u8],expired:&impl Fn()->bool,
    mut consume:impl FnMut(Vec<(&str,Node<'tree>)>)->Result<()>)->Result<()>{
    let mut cursor=QueryCursor::new();let mut progress=|_:&tree_sitter::QueryCursorState|if expired(){ControlFlow::Break(())}else{ControlFlow::Continue(())};
    let mut matches=cursor.matches_with_options(query,root,text,QueryCursorOptions::new().progress_callback(&mut progress));
    while let Some(matched)=matches.next(){if expired(){return Err("failed: Structure query budget exhausted".into());}
        consume(matched.captures().iter().map(|c|(query.capture_names()[c.index as usize],c.node)).collect())?;
    }
    drop(matches);
    if cursor.did_exceed_match_limit(){return Err("failed: Structure query match limit exceeded".into());}
    Ok(())
}
fn node_text<'a>(node:Node,text:&'a[u8])->&'a str{node.utf8_text(text).unwrap_or_default()}
fn unquote(text:&str)->&str{if text.len()>=2&&(text.starts_with('"')||text.starts_with('\'')){&text[1..text.len()-1]}else{text}}
fn span(node:Node)->(usize,usize){let start=node.start_position();let end=node.end_position();
    (start.row+1,(if end.column==0&&end.row>start.row{end.row}else{end.row+1}).max(start.row+1))}
fn push_symbol(symbols:&mut Vec<Value>,seen:&mut HashSet<String>,name:&str,kind:&str,unit:Node,signature:Option<Node>){
    let (start,end)=span(unit);let(sig_start,sig_end)=signature.map(span).unwrap_or((start,start));
    let key=format!("{kind}:{name}:{start}:{end}:{}",unit.kind());if !seen.insert(key){return;}
    symbols.push(json!({"name":name,"kind":kind,"range":{"startLine":start,"endLine":end},
        "signature":{"startLine":start.max(sig_start),"endLine":end.min(sig_end)}}));
}
fn function_like(kind:&str)->bool{matches!(kind,"arrow_function"|"function"|"function_expression"|"generator_function"|"class")}
fn binding(kind:&str)->bool{matches!(kind,"lexical_declaration"|"variable_declaration"|"public_field_definition"|"field_definition")}
fn initializer(node:Node)->Option<Node>{
    if matches!(node.kind(),"public_field_definition"|"field_definition"){return node.child_by_field_name("value");}
    if matches!(node.kind(),"lexical_declaration"|"variable_declaration"){
        let mut cursor=node.walk();let found=node.named_children(&mut cursor).find(|n|n.kind()=="variable_declarator");
        return found.and_then(|n|n.child_by_field_name("value"));
    }None
}
fn is_outline(node:Node)->bool{
    if matches!(node.kind(),"function_declaration"|"generator_function_declaration"|"class_declaration"|"class"|"abstract_class_declaration"|
        "interface_declaration"|"type_alias_declaration"|"enum_declaration"|"method_definition"|"function_signature"|"internal_module"|"module"){return true;}
    if !binding(node.kind()){return false;}
    if initializer(node).is_some_and(|n|function_like(n.kind())){return true;}
    let mut parent=node.parent();while let Some(p)=parent{if p.kind()=="statement_block"||function_like(p.kind()){return false;}parent=p.parent();}true
}
fn kind_for(node:Node)->&'static str{
    if let Some(initializer)=initializer(node){if initializer.kind()=="class"{return "class";}if function_like(initializer.kind()){return "function";}}
    let kind=node.kind();if matches!(kind,"method_definition"|"function_signature")||kind.contains("function"){"function"}
        else if kind.contains("class"){"class"}else if kind.contains("interface"){"interface"}else if kind.contains("enum"){"enum"}
        else if kind.contains("type_alias"){"type"}else if matches!(kind,"internal_module"|"module"){"module"}else{"variable"}
}
fn tags_kind(capture:&str)->&'static str{match capture.strip_prefix("definition.").unwrap_or_default(){
    "function"|"macro"=>"function","method"=>"method","constructor"=>"constructor","class"=>"class",
    "interface"|"trait"|"protocol"=>"interface","struct"|"union"=>"struct","enum"=>"enum","type"=>"type",
    "module"|"namespace"=>"module","package"=>"package","constant"|"field"|"property"|"variable"=>"variable",_=>"unknown"}}
fn line_has(node:Node,row:usize,matcher:impl Fn(&str)->bool,shared:&Shared)->Result<bool>{
    let mut stack=vec![node];while let Some(node)=stack.pop(){shared.check()?;
        if node.start_position().row>row||node.end_position().row<row{continue;}
        if matcher(node.kind()){return Ok(true);}let mut cursor=node.walk();stack.extend(node.children(&mut cursor));
    }Ok(false)
}
struct JsonOutline<'a>{symbols:&'a mut Vec<Value>,names:&'a mut HashSet<usize>,seen:&'a mut HashSet<String>,max_depth:usize,max_symbols:usize,text:&'a[u8],shared:&'a Shared}
impl JsonOutline<'_>{
    fn push(&mut self,name:&str,kind:&str,unit:Node,signature:Node)->bool{
        if self.symbols.len()>=self.max_symbols{return false;}push_symbol(self.symbols,self.seen,name,kind,unit,Some(signature));self.symbols.len()<self.max_symbols
    }
    fn collect(&mut self,root:Node)->Result<()>{
        let value=if matches!(root.kind(),"object"|"array"){Some(root)}else{let mut c=root.walk();let v=root.named_children(&mut c).find(|n|matches!(n.kind(),"object"|"array"));v};
        if let Some(value)=value{if self.push("$",value.kind(),value,value){self.value(value,0)?;}}Ok(())
    }
    fn value(&mut self,node:Node,depth:usize)->Result<bool>{
        self.shared.check()?;if depth>self.max_depth{return Ok(true);}let mut cursor=node.walk();
        for(index,child)in node.named_children(&mut cursor).enumerate(){
            if node.kind()=="object"&&child.kind()=="pair"{if !self.pair(child,depth)?{return Ok(false);}}
            else if node.kind()=="array"&&matches!(child.kind(),"object"|"array")&&depth<self.max_depth{
                if !self.push(&format!("[{index}]"),child.kind(),child,child)||!self.value(child,depth+1)?{return Ok(false);}
            }
        }Ok(true)
    }
    fn pair(&mut self,pair:Node,depth:usize)->Result<bool>{
        self.shared.check()?;let key=pair.child_by_field_name("key");let value=pair.child_by_field_name("value");
        if let Some(key)=key{self.names.insert(key.start_position().row+1);}
        let name=key.map(|k|unquote(node_text(k,self.text))).unwrap_or("property").to_string();
        let structured=value.is_some_and(|v|matches!(v.kind(),"object"|"array"));
        let top=pair.parent().filter(|p|p.kind()=="object").and_then(|p|p.parent()).is_some_and(|p|p.kind()=="document");
        if (top||structured)&&depth<=self.max_depth&&!self.push(&name,"property",pair,key.unwrap_or(pair)){return Ok(false);}
        if let Some(value)=value.filter(|_|structured&&depth<self.max_depth){
            if !self.push(&name,value.kind(),value,key.unwrap_or(value))||!self.value(value,depth+1)?{return Ok(false);}
        }Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn recipe() -> KernelComputeGrammarParams {
        let grammar = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../packages/web/application-host/lib/structure/runtime/tree-sitter-typescript.wasm");
        let hash = format!("sha256-{}", hex::encode(Sha256::digest(fs::read(&grammar).unwrap())));
        serde_json::from_value(json!({
            "recipeId": "test-full-typescript",
            "grammarPath": grammar,
            "grammarName": "typescript",
            "grammarHash": hash,
            "style": "code",
            "definitionQuery": "(function_declaration name: (identifier) @name) @unit",
            "literalCallQuery": "(call_expression function: (identifier) @fn arguments: (arguments (string) @literal))",
            "importQuery": "(import_statement source: (string) @source)"
        })).unwrap()
    }

    #[test]
    fn repeated_documents_share_compilation_without_sharing_analysis() {
        let mut syntax = SyntaxRuntime::default();
        let recipe = recipe();
        let shared = Shared::new();
        for index in 0..8 {
            let text = format!("import x from './x';\nfunction fn_{index}() {{ return fetch('/api/{index}'); }}");
            let hash = hex::encode(Sha256::digest(text.as_bytes()));
            let result = syntax.analyze(&recipe, &text, &[2], 30000, &hash, &shared).unwrap();
            assert_eq!(result["symbols"][0]["name"], format!("fn_{index}"));
            assert_eq!(result["calls"][0]["literal"], format!("/api/{index}"));
            assert_eq!(result["imports"][0]["source"], "./x");
            assert_eq!(result["contentHash"], hash);
            assert_eq!(syntax.compiled_query_count, 3);
        }
        let mut selected = recipe.clone();
        selected.recipe_id = "test-selected-typescript".into();
        selected.definition_query = "((function_declaration name: (identifier) @name) @unit (#eq? @name \"included\"))".into();
        let text = "function included() {}\nfunction excluded() {}";
        let hash = hex::encode(Sha256::digest(text.as_bytes()));
        let result = syntax.analyze(&selected, text, &[], 30000, &hash, &shared).unwrap();
        assert_eq!(result["symbols"].as_array().unwrap().len(), 1);
        assert_eq!(result["symbols"][0]["name"], "included");
        assert_eq!(syntax.compiled_query_count, 6);

        selected.recipe_id = "test-invalid-query".into();
        selected.definition_query = "(unknown_syntax_node) @unit".into();
        assert!(syntax.analyze(&selected, text, &[], 30000, &hash, &shared)
            .unwrap_err().contains("Grammar query is incompatible"));
    }

    #[test]
    fn latest_recipe_replaces_queries_and_revisiting_recompiles() {
        let mut syntax = SyntaxRuntime::default();
        let base = recipe();
        let shared = Shared::new();
        let text = (0..12).map(|index| format!("function fn_{index}() {{}}\n")).collect::<String>();
        let hash = hex::encode(Sha256::digest(text.as_bytes()));
        let recipes = (0..12).map(|index| {
            let mut selected = base.clone();
            selected.recipe_id = format!("test-replacement-{index}");
            selected.definition_query = format!(
                "((function_declaration name: (identifier) @name) @unit (#eq? @name \"fn_{index}\"))");
            selected
        }).collect::<Vec<_>>();
        for (index, selected) in recipes.iter().enumerate() {
            let result = syntax.analyze(selected, &text, &[], 30000, &hash, &shared).unwrap();
            assert_eq!(result["symbols"].as_array().unwrap().len(), 1);
            assert_eq!(result["symbols"][0]["name"], format!("fn_{index}"));
            assert_eq!(syntax.compiled_query_count, 3 * (index + 1));
            assert_eq!(syntax.languages.len(), 1);
            let cached = syntax.languages.values().next().unwrap();
            assert_eq!(cached.queries.as_ref().unwrap().recipe_id, selected.recipe_id);
        }
        // The old recipe remains usable, but its evicted queries must compile
        // again. A consecutive repeat then reuses that latest compilation.
        for _ in 0..2 {
            let result = syntax.analyze(&recipes[0], &text, &[], 30000, &hash, &shared).unwrap();
            assert_eq!(result["symbols"].as_array().unwrap().len(), 1);
            assert_eq!(result["symbols"][0]["name"], "fn_0");
            assert_eq!(syntax.compiled_query_count, 3 * (recipes.len() + 1));
            assert_eq!(syntax.languages.len(), 1);
            let cached = syntax.languages.values().next().unwrap();
            assert_eq!(cached.queries.as_ref().unwrap().recipe_id, recipes[0].recipe_id);
        }
    }

    #[test]
    fn compiled_queries_do_not_bypass_grammar_integrity_or_cancellation() {
        let mut syntax = SyntaxRuntime::default();
        let mut recipe = recipe();
        let text = "function current() {}";
        let hash = hex::encode(Sha256::digest(text.as_bytes()));
        syntax.analyze(&recipe, text, &[], 30000, &hash, &Shared::new()).unwrap();
        assert_eq!(syntax.compiled_query_count, 3);
        recipe.grammar_hash = Some("sha256-changed-after-admission".into());
        assert!(syntax.analyze(&recipe, text, &[], 30000, &hash, &Shared::new())
            .unwrap_err().contains("Grammar bytes changed"));
        let cancelled = Shared::new();
        cancelled.cancel();
        assert_eq!(syntax.analyze(&recipe, text, &[], 30000, &hash, &cancelled).unwrap_err(), "cancelled");
        assert_eq!(syntax.compiled_query_count, 3);
    }
}
