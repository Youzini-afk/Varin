import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeAnthropicCredentialOwner } from '../src/native-anthropic-auth.js';
import { HostCredentialAuthority } from '../src/credential-authority.js';
const jwt = (sub: string, serial: number) => [Buffer.from(JSON.stringify({alg:'RS256'})).toString('base64url'),Buffer.from(JSON.stringify({iss:'https://issuer.example.test',sub,aud:['fixture-audience'],exp:2000000000+serial,jti:`fake-${serial}`})).toString('base64url'),'fake-signature'].join('.');

test('locked Anthropic federation exchanges fake assertions with single-flight expiry refresh, principal fencing, and no token persistence', async t=>{
 const directory=await mkdtemp(join(tmpdir(),'varin-anthropic-wif-review-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const seen:Array<{path:string;body:Record<string,unknown>;beta:string|undefined}>=[];let fail=false;
 const server=createServer((request,response)=>{const chunks:Buffer[]=[];request.on('data',chunk=>chunks.push(chunk));request.on('end',()=>{
  seen.push({path:request.url!,body:JSON.parse(Buffer.concat(chunks).toString()) as Record<string,unknown>,beta:request.headers['anthropic-beta'] as string|undefined});
  setTimeout(()=>{response.writeHead(fail?401:200,{'content-type':'application/json'});response.end(JSON.stringify(fail?{error:'invalid_grant',error_description:'fake-private-upstream-body',assertion:'fake-secret-echo'}:{access_token:`fake-federation-token-${seen.length}`,token_type:'Bearer',expires_in:0}));},20);
 });});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
 const address=server.address();assert.ok(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}`;
 const file=join(directory,'assertion.jwt');await writeFile(file,jwt('principal-one',1));
 const env={ANTHROPIC_IDENTITY_TOKEN_FILE:file,ANTHROPIC_ORGANIZATION_ID:'fixture-org',ANTHROPIC_FEDERATION_RULE_ID:'fixture-rule',ANTHROPIC_WORKSPACE_ID:'fixture-workspace',ANTHROPIC_SERVICE_ACCOUNT_ID:'fixture-account'};
 const owner=new NativeAnthropicCredentialOwner();const source=(await owner.source(base,env))!;assert.ok(source);
 const headers=await Promise.all(Array.from({length:8},()=>owner.headers(source)));
 assert.equal(seen.length,1);assert.ok(headers.every(value=>value.authorization==='Bearer fake-federation-token-1'));
 assert.equal(seen[0]!.path,'/v1/oauth/token');assert.equal(seen[0]!.body.assertion,jwt('principal-one',1));
 assert.equal(seen[0]!.body.organization_id,'fixture-org');assert.equal(seen[0]!.body.workspace_id,'fixture-workspace');assert.match(seen[0]!.beta!,/oidc-federation/);
 await writeFile(file,jwt('principal-one',2));assert.equal((await owner.source(base,env))!.identity,source.identity);
 assert.equal((await owner.headers(source)).authorization,'Bearer fake-federation-token-2');assert.equal(seen[1]!.body.assertion,jwt('principal-one',2));
 await writeFile(file,jwt('principal-two',3));const switched=(await owner.source(base,env))!;assert.notEqual(switched.identity,source.identity);
 await assert.rejects(owner.headers(source),{code:'anthropic-federation-resolution-failed'});assert.equal(seen.length,2);
 assert.equal((await owner.headers(switched)).authorization,'Bearer fake-federation-token-3');
 assert.notEqual((await owner.source(base,{...env,ANTHROPIC_WORKSPACE_ID:'another-workspace'}))!.identity,switched.identity);
 assert.deepEqual(await readdir(directory),['assertion.jwt']);
 const agent=join(directory,'agent');const authority=HostCredentialAuthority.open(agent);
 await authority.modifyWithIntent('anthropic','replace',async()=>({type:'api_key',env}));
 await writeFile(join(agent,'models.json'),JSON.stringify({providers:{anthropic:{baseUrl:base,headers:{'anthropic-beta':'fixture-feature'},models:[{id:'claude-fixture',name:'Fixture',api:'anthropic-messages',maxTokens:128}]}}}));
 await authority.selectedModel('anthropic','claude-fixture');
 const scope=await authority.currentScope('anthropic','claude-fixture');const auth=await authority.getAuth('anthropic','claude-fixture');
 assert.equal(auth?.auth.headers?.authorization,'Bearer fake-federation-token-4');
 assert.ok(String(auth?.auth.headers?.['anthropic-beta']).includes('fixture-feature'));assert.ok(String(auth?.auth.headers?.['anthropic-beta']).includes('oauth-2025-04-20'));
 assert.deepEqual(await authority.currentScope('anthropic','claude-fixture'),scope);
 const disk=await readFile(join(agent,'auth.json'),'utf8');assert.equal(disk.includes('fake-federation-token'),false);assert.equal(disk.includes('fake-signature'),false);
 fail=true;await assert.rejects(authority.getAuth('anthropic','claude-fixture'),{code:'anthropic-federation-resolution-failed',message:'anthropic-federation-resolution-failed'});
 await writeFile(file,'invalid-secret-assertion');await assert.rejects(owner.source(base,env),{code:'anthropic-identity-token-invalid',message:'anthropic-identity-token-invalid'});
});

test('federation does not forward an identity assertion to a redirected token origin', async t=>{
 const directory=await mkdtemp(join(tmpdir(),'varin-wif-redirect-review-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 let forwarded=0;
 const sink=createServer((request,response)=>{request.resume();request.on('end',()=>{forwarded++;response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({access_token:'fake-redirect-token',token_type:'Bearer',expires_in:3600}));});});
 sink.listen(0,'127.0.0.1');await once(sink,'listening');const target=sink.address();assert.ok(target&&typeof target!=='string');
 const origin=createServer((_request,response)=>response.writeHead(307,{location:`http://127.0.0.1:${target.port}/capture`}).end());origin.listen(0,'127.0.0.1');await once(origin,'listening');const address=origin.address();assert.ok(address&&typeof address!=='string');
 t.after(async()=>{for(const server of [origin,sink]){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}});
 const file=join(directory,'assertion.jwt');await writeFile(file,jwt('redirect-principal',1));
 const owner=new NativeAnthropicCredentialOwner();const source=(await owner.source(`http://127.0.0.1:${address.port}`,{ANTHROPIC_IDENTITY_TOKEN_FILE:file,ANTHROPIC_ORGANIZATION_ID:'fixture-org',ANTHROPIC_FEDERATION_RULE_ID:'fixture-rule'}))!;
 const result=await owner.headers(source).catch(error=>error as Error);
 assert.equal(forwarded,0,'assertion body was sent to a different token origin');assert.ok(result instanceof Error);
});

test('stored subscription OAuth yields locked default CLI headers while an ordinary API key remains an API key', async t=>{
 const directory=await mkdtemp(join(tmpdir(),'varin-anthropic-subscription-review-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const authority=HostCredentialAuthority.open(directory);const access='sk-ant-oat-fake-fixture-access';
 await authority.modifyWithIntent('anthropic','replace',async()=>({type:'oauth',access,refresh:'fake-fixture-refresh',expires:2000000000000}));
 assert.equal(await authority.anthropicAuthentication('anthropic'),'oauth');
 const auth=await authority.getAuth('anthropic');
 assert.equal(auth?.auth.headers?.authorization,`Bearer ${access}`);assert.equal(auth?.auth.headers?.['x-app'],'cli');
 assert.equal(auth?.auth.headers?.['anthropic-beta'],'claude-code-20250219,oauth-2025-04-20');
 assert.match(String(auth?.auth.headers?.['user-agent']),/^claude-cli\//);
 await authority.modifyWithIntent('anthropic','replace',async()=>({type:'api_key',key:'fake-ordinary-api-key'}));
 assert.equal(await authority.anthropicAuthentication('anthropic'),'api-key');
 const ordinary=await authority.getAuth('anthropic');assert.equal(ordinary?.auth.apiKey,'fake-ordinary-api-key');assert.equal(ordinary?.auth.headers?.['x-app'],undefined);
});
